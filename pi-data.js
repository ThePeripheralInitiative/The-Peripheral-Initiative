/* ============================================================
   THE PERIPHERAL INITIATIVE — data layer
   pi-data.js
   ------------------------------------------------------------
   Load AFTER supabase-config.js, BEFORE home.html's own script:

     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="supabase-config.js"></script>
     <script src="pi-data.js"></script>

   ------------------------------------------------------------
   WHAT THIS IS

   home.html reads and writes everything through about a dozen
   small functions — getAllPosts(), getVotes(), isOwner() and so
   on. This file reimplements every one of them against Supabase
   while keeping the names and return shapes identical, so 1,600
   lines of rendering code keep working unchanged.

   ------------------------------------------------------------
   THE ONE REAL PROBLEM: SYNC vs ASYNC

   localStorage answers instantly. A database does not. But every
   render function in home.html is synchronous and expects data to
   be there the moment it asks.

   Rewriting all of them as async would mean touching nearly every
   line. Instead: load everything into memory ONCE at startup, let
   the render functions read that memory synchronously exactly as
   before, and refresh the cache after any write.

   So the flow is:

     PI.load()            -> one batch of queries, fills the cache
     getAllPosts()        -> reads the cache, instant, unchanged
     await PI.addPost()   -> writes to the database, refreshes,
                             then the caller re-renders

   Only the WRITE paths in home.html need `await` added. Reads are
   untouched.

   ------------------------------------------------------------
   WHAT IS NO LONGER POSSIBLE, DELIBERATELY

   Under localStorage, posts and votes lived in the visitor's own
   browser, so anyone could edit them with developer tools. Every
   write now goes through RLS. A member cannot post as someone
   else, cannot vote twice, cannot fabricate a score. The client
   asks; the database decides.
   ============================================================ */

const PI = (function () {

  /* In-memory mirror of what the database holds. Rendering reads
     from here so it can stay synchronous. */
  const cache = {
    user:     null,   // auth.users row (id, email)
    profile:  null,   // profiles row (username, role, is_banned)
    posts:    [],     // shaped like home.html's old post objects
    comments: {},     // { postId: [comment, ...] }
    votes:    {},     // { postId: 'up' | 'down' }
    cvotes:   {},     // { commentId: 'up' | 'down' }
    saved:    [],     // [postId, ...]
    pages:    {},     // { pageId: profileObject } — artists & labels
    members:  [],     // every account, for the admin panel
    vreqs:    [],     // verification requests (own, or all if staff)
    reports:  [],     // reports (own, or all if staff)
    notifs:   [],     // your notifications only
    loaded:   false,
    error:    null
  };


  /* ----------------------------------------------------------
     SHAPE ADAPTERS

     The database stores what is correct; home.html expects what
     it was written against. These translate between the two so
     neither has to change.

     Notably: `timestamp` is milliseconds because the sort
     algorithms do arithmetic on it, and `alias` is a username
     rather than an author id because that is what gets rendered.
     ---------------------------------------------------------- */

  /* NOTE ON THE QUERIES ABOVE AND BELOW
     ------------------------------------
     They ask for `profiles!posts_author_id_fkey(username)` rather than
     the tidier `profiles(username)`, and that is deliberate.

     `posts` can reach `profiles` by three different routes: directly
     through author_id, or indirectly via post_votes.voter_id, or via
     saves.saver_id. PostgREST refuses to guess which one was meant
     (error PGRST201) and returns nothing at all.

     Naming the foreign key removes the ambiguity. Same reason
     `comments` names comments_author_id_fkey. Do not shorten these
     back — it silently empties the feed.
     ------------------------------------ */

  /* IMPORTANT: the property NAMES here are not free choices.
     home.html renders p.author, c.author and c.text — those exact
     spellings appear across its templates. Shaping rows with
     `alias` and `body` instead produced "Posted by u/undefined",
     because the renderer looked for a field that wasn't there.

     Both spellings are provided: the ones home.html already uses,
     plus clearer aliases for any new code. */

  function shapePost(row, scoreMap) {
    const name = row.profiles ? row.profiles.username : '[deleted]';
    return {
      id:        row.id,
      genre:     row.genre,
      title:     row.title,
      body:      row.body || '',
      author:    name,            // what home.html renders
      alias:     name,            // convenience alias
      authorId:  row.author_id,
      timestamp: new Date(row.created_at).getTime(),
      score:     scoreMap[row.id] || 0,
      /* Zero on purpose. home.html computes the visible count as
         getComments(p.id).length + (p.commentCount || 0), so anything
         non-zero here would be counted twice. */
      commentCount: 0,
      removed:   row.is_removed,
      edited:    !!row.edited_at,
      editedAt:  row.edited_at ? new Date(row.edited_at).getTime() : null,
      selfDeleted: !!row.self_deleted,
      /* Computed once here rather than in the templates, so every
         place that renders a post agrees on who may act on it. */
      canEdit:   !!(cache.user && row.author_id === cache.user.id),
      canRemove: !!(cache.profile &&
                    (cache.profile.role === 'owner' || cache.profile.role === 'moderator'))
    };
  }

  function shapeComment(row, scoreMap) {
    const name = row.profiles ? row.profiles.username : '[deleted]';
    return {
      id:        row.id,
      postId:    row.post_id,
      text:      row.body,        // what home.html renders
      body:      row.body,        // convenience alias
      author:    name,
      alias:     name,
      authorId:  row.author_id,
      timestamp: new Date(row.created_at).getTime(),
      score:     (scoreMap && scoreMap[row.id]) || 0,
      removed:   row.is_removed,
      edited:    !!row.edited_at,
      selfDeleted: !!row.self_deleted,
      canEdit:   !!(cache.user && row.author_id === cache.user.id),
      canRemove: !!(cache.profile &&
                    (cache.profile.role === 'owner' || cache.profile.role === 'moderator'))
    };
  }

  /* Artist and label pages. The old code kept `linkedEmail` and
     matched on it to decide who owned a profile — which was only
     ever as trustworthy as a localStorage value. Ownership is now
     owner_id, checked by the database. */
  function shapePage(row) {
    const links = row.links || {};
    return {
      id:          row.id,
      type:        row.kind,                        // 'artist' | 'label'
      name:        row.name,
      bio:         row.bio || '',
      verified:    row.verification === 'verified',
      pending:     row.verification === 'pending',
      rejected:    row.verification === 'rejected',
      status:      row.verification,
      rejectReason: row.reject_reason || '',
      ownerId:     row.owner_id,
      affiliation: links.affiliation || '',
      genre:       links.genre || '',
      genres:      links.genres || [],
      spotify:     links.spotify || '',
      appleMusic:  links.appleMusic || '',
      bandcamp:    links.bandcamp || '',
      soundcloud:  links.soundcloud || '',
      instagram:   links.instagram || '',
      website:     links.website || '',
      merch:       links.merch || ''
    };
  }


  /* ----------------------------------------------------------
     LOAD

     One batch of queries at startup. Runs them in parallel rather
     than in sequence — six round trips one after another is a
     visible delay; six at once is one round trip's worth.
     ---------------------------------------------------------- */

  async function load() {
    cache.error = null;

    if (typeof sb === 'undefined' || !sb) {
      cache.error = 'not_configured';
      cache.loaded = true;
      return cache;
    }

    try {
      const { data: userData } = await sb.auth.getUser();
      cache.user = userData ? userData.user : null;
    } catch (e) {
      cache.user = null;
    }

    /* Signed-out visitors can read the forum but have no votes,
       saves, or profile — so skip those queries entirely rather
       than firing them and discarding empty results. */
    const signedIn = !!cache.user;

    const queries = [
      sb.from('posts')
        .select('id, author_id, genre, title, body, is_removed, self_deleted, edited_at, created_at, profiles!posts_author_id_fkey(username)')
        .eq('is_removed', false)
        .order('created_at', { ascending: false }),

      sb.from('post_scores').select('post_id, score'),

      sb.from('comments')
        .select('id, post_id, author_id, body, is_removed, self_deleted, edited_at, created_at, profiles!comments_author_id_fkey(username)')
        .eq('is_removed', false)
        .order('created_at', { ascending: true }),

      sb.from('pages')
        .select('id, owner_id, kind, name, bio, links, verification, reject_reason')
        .order('created_at', { ascending: true }),

      sb.from('comment_scores').select('comment_id, score'),

      /* Every account, for the admin panel. Safe to read: profiles is
         world-readable by design so usernames can render on posts.
         Note what is NOT here — email addresses live in auth.users,
         which is not exposed through the API at all. The old panel
         listed people by email; it now lists them by username, which
         is both what the database can offer and less to leak. */
      sb.from('profiles')
        .select('id, username, role, is_banned, deletion_requested_at, created_at')
        .order('created_at', { ascending: true }),

      /* RLS returns your own requests, or every request if you are
         staff. The same query serves both an applicant checking their
         status and a moderator working the queue — no separate
         "admin" endpoint to secure, because the policy already
         decides who sees what. */
      sb.from('verification_requests')
        .select('id, page_id, submitted_by, evidence, status, claim_code, review_note, created_at, reviewed_at, pages(name, kind, owner_id)')
        .order('created_at', { ascending: false }),

      /* Same policy shape as verification requests: you see your own,
         staff see all. A reporter never learns the outcome of someone
         else's report, and never learns who reported whom — which is
         what the Community Guidelines promise. */
      sb.from('reports')
        .select('id, reporter_id, target_type, target_id, reasons, status, created_at, reviewed_at')
        .order('created_at', { ascending: false })
    ];

    if (signedIn) {
      queries.push(
        /* Only yours — RLS has no policy letting anyone read another
           person's notifications, so this cannot return someone
           else's even if the filter were removed. */
        sb.from('notifications')
          .select('id, actor_id, kind, post_id, comment_id, page_id, preview, read_at, created_at')
          .eq('user_id', cache.user.id)
          .order('created_at', { ascending: false })
          .limit(30),
        sb.from('profiles')
          .select('id, username, role, is_banned')
          .eq('id', cache.user.id)
          .maybeSingle(),
        sb.from('post_votes').select('post_id, direction').eq('voter_id', cache.user.id),
        sb.from('comment_votes').select('comment_id, direction').eq('voter_id', cache.user.id),
        sb.from('saves').select('post_id').eq('saver_id', cache.user.id)
      );
    }

    let results;
    try {
      results = await Promise.all(queries);
    } catch (e) {
      console.error('[Peripheral] load failed:', e);
      cache.error = 'load_failed';
      cache.loaded = true;
      return cache;
    }

    const [postsRes, scoresRes, commentsRes, pagesRes, cScoresRes, membersRes,
           vreqRes, reportsRes, notifRes, profileRes, votesRes, cvotesRes, savesRes] = results;

    /* Report every failed query by name.
       Without this, a query that errors and a table that is genuinely
       empty produce the same thing: an empty array and a silent UI.
       That ambiguity cost real debugging time, so failures are now
       loud. */
    const named = [
      ['posts', postsRes], ['post_scores', scoresRes],
      ['comments', commentsRes], ['pages', pagesRes],
      ['comment_scores', cScoresRes], ['members', membersRes],
      ['verification_requests', vreqRes], ['reports', reportsRes],
      ['notifications', notifRes],
      ['profiles', profileRes], ['post_votes', votesRes],
      ['comment_votes', cvotesRes], ['saves', savesRes]
    ];
    let anyFailed = false;
    named.forEach(([name, res]) => {
      if (res && res.error) {
        anyFailed = true;
        console.error('[Peripheral] query failed on "' + name + '":',
                      res.error.message,
                      res.error.hint ? '| HINT: ' + res.error.hint : '',
                      res.error.code ? '| code ' + res.error.code : '');
      }
    });
    if (anyFailed) {
      console.warn('[Peripheral] Some data could not be loaded. The page will ' +
        'render with whatever succeeded — so an empty feed here may mean a ' +
        'failed query rather than an empty forum.');
    }

    /* Scores come from a computed view, never a stored number, so
       there is nothing a client could tamper with. */
    const scoreMap = {};
    if (scoresRes && !scoresRes.error && scoresRes.data) {
      scoresRes.data.forEach(r => { scoreMap[r.post_id] = r.score; });
    }

    cache.posts = (postsRes && !postsRes.error && postsRes.data)
      ? postsRes.data.map(r => shapePost(r, scoreMap))
      : [];

    const cScoreMap = {};
    if (cScoresRes && !cScoresRes.error && cScoresRes.data) {
      cScoresRes.data.forEach(r => { cScoreMap[r.comment_id] = r.score; });
    }

    cache.comments = {};
    if (commentsRes && !commentsRes.error && commentsRes.data) {
      commentsRes.data.forEach(r => {
        if (!cache.comments[r.post_id]) cache.comments[r.post_id] = [];
        cache.comments[r.post_id].push(shapeComment(r, cScoreMap));
      });
    }

    cache.pages = {};
    if (pagesRes && !pagesRes.error && pagesRes.data) {
      pagesRes.data.forEach(r => { cache.pages[r.id] = shapePage(r); });
    }

    cache.members = (membersRes && !membersRes.error && membersRes.data)
      ? membersRes.data
      : [];

    cache.notifs = (notifRes && !notifRes.error && notifRes.data)
      ? notifRes.data.map(n => {
          const actor = cache.members.find(m => m.id === n.actor_id);
          return {
            id:        n.id,
            kind:      n.kind,
            actor:     actor ? actor.username : null,
            postId:    n.post_id,
            commentId: n.comment_id,
            pageId:    n.page_id,
            preview:   n.preview || '',
            read:      !!n.read_at,
            createdAt: n.created_at
          };
        })
      : [];

    cache.reports = (reportsRes && !reportsRes.error && reportsRes.data)
      ? reportsRes.data.map(r => ({
          id:         r.id,
          reporterId: r.reporter_id,
          targetType: r.target_type,
          targetId:   r.target_id,
          reasons:    r.reasons || [],
          status:     r.status,
          createdAt:  r.created_at,
          reviewedAt: r.reviewed_at
        }))
      : [];

    cache.vreqs = (vreqRes && !vreqRes.error && vreqRes.data)
      ? vreqRes.data.map(r => ({
          id:        r.id,
          pageId:    r.page_id,
          pageName:  r.pages ? r.pages.name : '(deleted page)',
          pageKind:  r.pages ? r.pages.kind : '',
          submittedBy: r.submitted_by,
          urls:      (r.evidence && r.evidence.urls) || [],
          note:      (r.evidence && r.evidence.note) || '',
          code:      r.claim_code,
          status:    r.status,
          reviewNote: r.review_note || '',
          createdAt: r.created_at,
          reviewedAt: r.reviewed_at
        }))
      : [];

    cache.profile = (profileRes && !profileRes.error) ? profileRes.data : null;

    cache.votes = {};
    if (votesRes && !votesRes.error && votesRes.data) {
      votesRes.data.forEach(r => {
        cache.votes[r.post_id] = r.direction === 1 ? 'up' : 'down';
      });
    }

    cache.cvotes = {};
    if (cvotesRes && !cvotesRes.error && cvotesRes.data) {
      cvotesRes.data.forEach(r => {
        cache.cvotes[r.comment_id] = r.direction === 1 ? 'up' : 'down';
      });
    }

    cache.saved = (savesRes && !savesRes.error && savesRes.data)
      ? savesRes.data.map(r => r.post_id)
      : [];

    cache.loaded = true;
    return cache;
  }


  /* Refresh only what a write touched, rather than reloading
     everything. Keeps interactions feeling immediate. */
  async function refreshPosts() {
    const [postsRes, scoresRes] = await Promise.all([
      sb.from('posts')
        .select('id, author_id, genre, title, body, is_removed, self_deleted, edited_at, created_at, profiles!posts_author_id_fkey(username)')
        .eq('is_removed', false)
        .order('created_at', { ascending: false }),
      sb.from('post_scores').select('post_id, score')
    ]);
    const scoreMap = {};
    if (!scoresRes.error && scoresRes.data) {
      scoresRes.data.forEach(r => { scoreMap[r.post_id] = r.score; });
    }
    cache.posts = (!postsRes.error && postsRes.data)
      ? postsRes.data.map(r => shapePost(r, scoreMap))
      : cache.posts;
  }

  async function refreshComments(postId) {
    const [cRes, sRes] = await Promise.all([
      sb.from('comments')
        .select('id, post_id, author_id, body, is_removed, self_deleted, edited_at, created_at, profiles!comments_author_id_fkey(username)')
        .eq('post_id', postId)
        .eq('is_removed', false)
        .order('created_at', { ascending: true }),
      sb.from('comment_scores').select('comment_id, score')
    ]);
    const map = {};
    if (!sRes.error && sRes.data) sRes.data.forEach(r => { map[r.comment_id] = r.score; });
    if (!cRes.error) cache.comments[postId] = (cRes.data || []).map(r => shapeComment(r, map));
  }

  async function refreshPages() {
    const { data, error } = await sb.from('pages')
      .select('id, owner_id, kind, name, bio, links, verification, reject_reason')
      .order('created_at', { ascending: true });
    if (!error) {
      cache.pages = {};
      (data || []).forEach(r => { cache.pages[r.id] = shapePage(r); });
    }
  }


  /* ----------------------------------------------------------
     WRITES

     Each returns { ok, error }. The database is the referee: if a
     policy refuses, ok is false and nothing changed. The UI should
     react to the result rather than assuming success.
     ---------------------------------------------------------- */

  async function addPost(genre, title, body) {
    if (!cache.user) return { ok: false, error: 'not_signed_in' };
    const { error } = await sb.from('posts').insert({
      author_id: cache.user.id,
      genre: genre,
      title: title,
      body: body || null
    });
    if (error) {
      console.error('[Peripheral] addPost FAILED:', error.message,
                    '| code', error.code,
                    error.details ? '| ' + error.details : '',
                    error.hint ? '| HINT: ' + error.hint : '');
      console.error('[Peripheral] attempted author_id:', cache.user.id, 'genre:', genre);
      return { ok: false, error: error.message };
    }
    await refreshPosts();
    return { ok: true };
  }

  async function addComment(postId, body) {
    if (!cache.user) return { ok: false, error: 'not_signed_in' };
    const { error } = await sb.from('comments').insert({
      post_id: postId,
      author_id: cache.user.id,
      body: body
    });
    if (error) {
      console.error('[Peripheral] addComment:', error);
      return { ok: false, error: error.message };
    }
    await refreshComments(postId);
    return { ok: true };
  }

  /* Voting the same way twice removes the vote — matching the old
     behaviour. The primary key on (post_id, voter_id) makes double
     voting impossible regardless of what the client sends. */
  async function setVote(postId, dir) {
    if (!cache.user) return { ok: false, error: 'not_signed_in' };
    const current = cache.votes[postId];

    if (current === dir) {
      const { error } = await sb.from('post_votes').delete()
        .eq('post_id', postId).eq('voter_id', cache.user.id);
      if (error) return { ok: false, error: error.message };
      delete cache.votes[postId];
    } else {
      const { error } = await sb.from('post_votes')
        .upsert({ post_id: postId, voter_id: cache.user.id,
                  direction: dir === 'up' ? 1 : -1 },
                { onConflict: 'post_id,voter_id' });
      if (error) return { ok: false, error: error.message };
      cache.votes[postId] = dir;
    }
    await refreshPosts();
    return { ok: true };
  }

  async function setCommentVote(commentId, dir) {
    if (!cache.user) return { ok: false, error: 'not_signed_in' };
    const current = cache.cvotes[commentId];

    if (current === dir) {
      const { error } = await sb.from('comment_votes').delete()
        .eq('comment_id', commentId).eq('voter_id', cache.user.id);
      if (error) return { ok: false, error: error.message };
      delete cache.cvotes[commentId];
    } else {
      const { error } = await sb.from('comment_votes')
        .upsert({ comment_id: commentId, voter_id: cache.user.id,
                  direction: dir === 'up' ? 1 : -1 },
                { onConflict: 'comment_id,voter_id' });
      if (error) return { ok: false, error: error.message };
      cache.cvotes[commentId] = dir;
    }
    // Find which post this comment belongs to so its score refreshes.
    for (const pid in cache.comments) {
      if (cache.comments[pid].some(c => c.id === commentId)) {
        await refreshComments(pid);
        break;
      }
    }
    return { ok: true };
  }

  async function toggleSave(postId) {
    if (!cache.user) return { ok: false, error: 'not_signed_in' };
    const i = cache.saved.indexOf(postId);

    if (i >= 0) {
      const { error } = await sb.from('saves').delete()
        .eq('post_id', postId).eq('saver_id', cache.user.id);
      if (error) return { ok: false, error: error.message };
      cache.saved.splice(i, 1);
      return { ok: true, saved: false };
    }

    const { error } = await sb.from('saves')
      .insert({ post_id: postId, saver_id: cache.user.id });
    if (error) return { ok: false, error: error.message };
    cache.saved.push(postId);
    return { ok: true, saved: true };
  }

  /* Editing. edited_at is stamped by a database trigger, not here —
     otherwise a client could change the text and decline to record
     that it had. */
  async function editPost(postId, title, body) {
    if (!cache.user) return { ok: false, error: 'not_signed_in' };
    const { error } = await sb.from('posts')
      .update({ title: title, body: body || null })
      .eq('id', postId);
    if (error) {
      console.error('[Peripheral] editPost:', error.message);
      return { ok: false, error: error.message };
    }
    await refreshPosts();
    return { ok: true };
  }

  async function editComment(commentId, postId, body) {
    if (!cache.user) return { ok: false, error: 'not_signed_in' };
    const { error } = await sb.from('comments')
      .update({ body: body })
      .eq('id', commentId);
    if (error) return { ok: false, error: error.message };
    await refreshComments(postId);
    return { ok: true };
  }

  /* The author removing their own. Soft: the row survives so replies
     survive with it. Both flags move together, which is what lets a
     change of mind stay distinguishable from a takedown afterwards. */
  async function selfDeletePost(postId) {
    if (!cache.user) return { ok: false, error: 'not_signed_in' };
    const { error } = await sb.from('posts')
      .update({ is_removed: true, self_deleted: true })
      .eq('id', postId);
    if (error) return { ok: false, error: error.message };
    await refreshPosts();
    return { ok: true };
  }

  async function selfDeleteComment(commentId, postId) {
    if (!cache.user) return { ok: false, error: 'not_signed_in' };
    const { error } = await sb.from('comments')
      .update({ is_removed: true, self_deleted: true })
      .eq('id', commentId);
    if (error) return { ok: false, error: error.message };
    await refreshComments(postId);
    return { ok: true };
  }

  /* Staff removal. The reason is required rather than optional: the
     Community Guidelines promise the user is told what happened and
     why, and an appeal reviewed by a different moderator is not
     possible if nobody recorded the original grounds. */
  async function moderatorRemovePost(postId, reason) {
    if (!cache.profile) return { ok: false, error: 'not_signed_in' };
    const { error } = await sb.from('posts').update({
      is_removed: true,
      self_deleted: false,
      removed_at: new Date().toISOString(),
      removed_by: cache.user.id,
      removed_reason: reason
    }).eq('id', postId);
    if (error) {
      console.error('[Peripheral] moderatorRemovePost:', error.message);
      return { ok: false, error: error.message };
    }
    await refreshPosts();
    return { ok: true };
  }

  async function moderatorRemoveComment(commentId, postId, reason) {
    if (!cache.profile) return { ok: false, error: 'not_signed_in' };
    const { error } = await sb.from('comments').update({
      is_removed: true,
      self_deleted: false,
      removed_at: new Date().toISOString(),
      removed_by: cache.user.id,
      removed_reason: reason
    }).eq('id', commentId);
    if (error) return { ok: false, error: error.message };
    await refreshComments(postId);
    return { ok: true };
  }

  /* Restoring is what makes an appeal mean anything. */
  async function restorePost(postId) {
    const { error } = await sb.from('posts').update({
      is_removed: false, removed_at: null,
      removed_by: null, removed_reason: null, self_deleted: false
    }).eq('id', postId);
    if (error) return { ok: false, error: error.message };
    await refreshPosts();
    return { ok: true };
  }

  async function report(targetType, targetId, reasons) {
    if (!cache.user) return { ok: false, error: 'not_signed_in' };
    const { error } = await sb.from('reports').insert({
      reporter_id: cache.user.id,
      target_type: targetType,
      target_id: targetId,
      reasons: reasons
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }


  /* ----------------------------------------------------------
     ARTIST & LABEL PAGES

     Under the old system the owner created these from an admin
     panel and a localStorage flag decided who could. Creation is
     now open to any member — anyone may claim to be an artist —
     but VERIFICATION is staff-only, enforced by a database
     trigger. That is the gate that matters, since verification is
     what unlocks uploading.
     ---------------------------------------------------------- */

  async function createPage(kind, name, bio, links) {
    if (!cache.user) return { ok: false, error: 'not_signed_in' };
    const { error } = await sb.from('pages').insert({
      owner_id: cache.user.id,
      kind: kind,
      name: name,
      bio: bio || null,
      links: links || {}
    });
    if (error) return { ok: false, error: error.message };
    await refreshPages();
    return { ok: true };
  }

  async function updatePage(pageId, fields) {
    if (!cache.user) return { ok: false, error: 'not_signed_in' };
    const { error } = await sb.from('pages').update(fields).eq('id', pageId);
    if (error) return { ok: false, error: error.message };
    await refreshPages();
    return { ok: true };
  }

  /* Staff only. A non-staff caller gets refused by the trigger,
     not by this function — which is the correct place for it. */
  async function setPageVerification(pageId, status) {
    const { error } = await sb.from('pages').update({
      verification: status,
      verified_at: status === 'verified' ? new Date().toISOString() : null,
      verified_by: status === 'verified' ? cache.user.id : null
    }).eq('id', pageId);
    if (error) return { ok: false, error: error.message };
    await refreshPages();
    return { ok: true };
  }

  async function deletePage(pageId) {
    const { error } = await sb.from('pages').delete().eq('id', pageId);
    if (error) return { ok: false, error: error.message };
    await refreshPages();
    return { ok: true };
  }


  /* Staff only. A member calling this is refused by the trigger, not
     by this function — which is the correct place for the decision.
     The old banUser() rewrote a localStorage array, meaning the button
     appeared to work and changed nothing anywhere. */
  async function setBanned(userId, banned) {
    const { error } = await sb.from('profiles')
      .update({ is_banned: banned })
      .eq('id', userId);
    if (error) {
      console.error('[Peripheral] setBanned:', error.message);
      return { ok: false, error: error.message };
    }
    const m = cache.members.find(x => x.id === userId);
    if (m) m.is_banned = banned;
    return { ok: true };
  }

  /* Submit a claim. The code is NOT sent from here — the database
     generates it on insert and we read it back, so an applicant
     cannot choose a code they have already placed somewhere. */
  async function submitVerification(pageId, urls, note) {
    if (!cache.user) return { ok: false, error: 'not_signed_in' };
    const { data, error } = await sb.from('verification_requests')
      .insert({
        page_id: pageId,
        submitted_by: cache.user.id,
        evidence: { urls: urls, note: note || '' }
      })
      .select('claim_code')
      .single();

    if (error) {
      console.error('[Peripheral] submitVerification:', error.message);
      if (error.code === '23505') {
        return { ok: false, error: 'A request for this page is already open.' };
      }
      return { ok: false, error: error.message };
    }
    await load();
    return { ok: true, code: data.claim_code };
  }

  /* Staff decision. Approving does two things that must agree: it
     resolves the request AND flips the page. Done in that order so a
     failure at the second step leaves an unresolved request rather
     than a verified page with no record of why. */
  async function resolveVerification(requestId, pageId, approve, note) {
    if (!cache.profile) return { ok: false, error: 'not_signed_in' };

    const { error: e1 } = await sb.from('verification_requests').update({
      status: approve ? 'verified' : 'rejected',
      reviewed_by: cache.user.id,
      reviewed_at: new Date().toISOString(),
      review_note: note || null
    }).eq('id', requestId);

    if (e1) {
      console.error('[Peripheral] resolveVerification:', e1.message);
      return { ok: false, error: e1.message };
    }

    const { error: e2 } = await sb.from('pages').update({
      verification: approve ? 'verified' : 'rejected',
      verified_at: approve ? new Date().toISOString() : null,
      verified_by: approve ? cache.user.id : null,
      reject_reason: approve ? null : (note || null)
    }).eq('id', pageId);

    if (e2) {
      console.error('[Peripheral] resolveVerification page update:', e2.message);
      return { ok: false, error: e2.message };
    }

    await load();
    return { ok: true };
  }

  /* Staff decision on a report.

     Three outcomes rather than two, matching the moderation framework:
     an action taken, a dismissal in good faith, and a dismissal of
     something the reporter knew was fine. Only the last counts against
     the reporter — because reporting a real problem should never feel
     risky, and that distinction is worthless if the interface collapses
     it into "dismissed". */
  async function resolveReport(reportId, outcome) {
    if (!cache.profile) return { ok: false, error: 'not_signed_in' };
    const { error } = await sb.from('reports').update({
      status: outcome,               // 'actioned' | 'dismissed_good_faith' | 'dismissed_malicious'
      reviewed_by: cache.user.id,
      reviewed_at: new Date().toISOString()
    }).eq('id', reportId);
    if (error) {
      console.error('[Peripheral] resolveReport:', error.message);
      return { ok: false, error: error.message };
    }
    await load();
    return { ok: true };
  }

  /* Records the request and signs them out. It cannot complete the
     deletion — removing an auth user needs the service_role key, which
     must never reach a browser. An owner finishes it from the
     dashboard, and the cascade removes their posts, comments, votes
     and saves along with the account. */
  async function requestDeletion() {
    if (!cache.user) return { ok: false, error: 'not_signed_in' };
    const { error } = await sb.from('profiles')
      .update({ deletion_requested_at: new Date().toISOString() })
      .eq('id', cache.user.id);
    if (error) {
      console.error('[Peripheral] requestDeletion:', error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  }

  async function cancelDeletion(userId) {
    const { error } = await sb.from('profiles')
      .update({ deletion_requested_at: null })
      .eq('id', userId);
    if (error) return { ok: false, error: error.message };
    await load();
    return { ok: true };
  }

  async function markNotificationsRead(ids) {
    if (!cache.user || !ids.length) return { ok: true };
    const { error } = await sb.from('notifications')
      .update({ read_at: new Date().toISOString() })
      .in('id', ids);
    if (error) return { ok: false, error: error.message };
    cache.notifs.forEach(n => { if (ids.includes(n.id)) n.read = true; });
    return { ok: true };
  }

  async function clearNotifications() {
    if (!cache.user) return { ok: true };
    const { error } = await sb.from('notifications')
      .delete().eq('user_id', cache.user.id);
    if (error) return { ok: false, error: error.message };
    cache.notifs = [];
    return { ok: true };
  }

  async function signOut() {
    try { await sb.auth.signOut(); } catch (e) {}
    cache.user = null;
    cache.profile = null;
    cache.votes = {};
    cache.cvotes = {};
    cache.saved = [];
  }


  return {
    load, cache,
    refreshPosts, refreshComments, refreshPages,
    addPost, addComment, setVote, setCommentVote, toggleSave, report,
    editPost, editComment, selfDeletePost, selfDeleteComment,
    moderatorRemovePost, moderatorRemoveComment, restorePost,
    createPage, updatePage, setPageVerification, deletePage,
    setBanned, submitVerification, resolveVerification, resolveReport,
    requestDeletion, cancelDeletion,
    markNotificationsRead, clearNotifications, signOut
  };
})();


/* ============================================================
   COMPATIBILITY SHIMS

   These deliberately keep the names home.html already calls, so
   the rendering code does not have to change. Each one reads the
   in-memory cache, so it stays synchronous exactly as before.
   ============================================================ */

/* Was: localStorage 'pi_verified' and 'pi_alias'.
   A signed-in account with no username is possible — someone who
   confirmed their email and closed the tab before choosing one —
   so `verified` requires BOTH a session and a profile. */
function getAuth() {
  return {
    verified: !!(PI.cache.user && PI.cache.profile),
    alias:    PI.cache.profile ? PI.cache.profile.username : '',
    email:    PI.cache.user ? PI.cache.user.email : '',
    banned:   PI.cache.profile ? PI.cache.profile.is_banned : false
  };
}

/* Was: localStorage.getItem('pi_role') === 'owner' — a value the
   visitor could set themselves in developer tools. Now a database
   column that only another owner can change.

   This still runs in the browser, so it can still be faked to
   reveal the admin UI. The difference is that the buttons no
   longer work: every write behind them is refused by RLS. The
   check is now cosmetic, and the enforcement is server-side,
   which is the correct arrangement. */
function isOwner() {
  return !!(PI.cache.profile && PI.cache.profile.role === 'owner');
}

function isStaff() {
  return !!(PI.cache.profile &&
    (PI.cache.profile.role === 'owner' || PI.cache.profile.role === 'moderator'));
}

/* Alias. home.html's renderThread() calls getCVotes(); leaving it
   undefined threw a ReferenceError mid-render, so the thread panel
   silently stayed empty and comments looked broken. */
function getCVotes()        { return PI.cache.cvotes; }

/* Replaces the old tryGet('pi_registered', []) — a localStorage array
   that only ever knew about accounts created in THIS browser. Now the
   real member list. Shaped with `identity` so the existing admin panel
   template keeps working, but it holds a username rather than an
   email, because emails are not exposed through the API. */
/* Every request, or just your own — RLS already decided which. */
function getVerificationRequests() { return PI.cache.vreqs; }

function getNotifications()   { return PI.cache.notifs; }
function getUnreadCount()     { return PI.cache.notifs.filter(n => !n.read).length; }

function getDeletionRequests() {
  return PI.cache.members.filter(m => m.deletion_requested_at);
}

function getOpenReports() {
  return PI.cache.reports.filter(r => r.status === 'open');
}

function getPendingVerifications() {
  return PI.cache.vreqs.filter(r => r.status === 'pending');
}

/* The open request for a page you own, if there is one. */
function getMyVerificationRequest(pageId) {
  return PI.cache.vreqs.find(r => r.pageId === pageId && r.status === 'pending') || null;
}

function getRegisteredUsers() {
  return PI.cache.members.map(m => ({
    id:       m.id,
    identity: m.username,
    deletionRequested: m.deletion_requested_at || null,
    alias:    m.username,
    role:     m.role,
    banned:   m.is_banned,
    joined:   m.created_at
  }));
}

/* Local UI preferences — genuinely fine in localStorage.

   These are cosmetic toggles that belong to a device, not an
   account: which sort you last used, panel states, and so on. There
   is no reason to store them server-side, and no harm if someone
   edits them, because they grant nothing.

   Kept because home.html's settings and admin panels still call
   them. Removing them threw a ReferenceError and left those panels
   blank. */
function tryGet(k, fb) {
  try { const v = JSON.parse(localStorage.getItem(k)); return v === null ? fb : v; }
  catch (e) { return fb; }
}
function trySet(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
}

function getAllPosts()      { return PI.cache.posts; }
function getUserPosts()     { return PI.cache.posts; }
function getVotes()         { return PI.cache.votes; }
function getCommentVotes()  { return PI.cache.cvotes; }
function getSaved()         { return PI.cache.saved; }
function getComments(pid)   { return PI.cache.comments[pid] || []; }
function getProfiles()      { return PI.cache.pages; }

/* Was matched by email against a localStorage value. Now by
   owner_id, which the database assigns and enforces. */
function getMyProfile() {
  if (!PI.cache.user) return null;
  return Object.values(PI.cache.pages)
    .find(p => p.ownerId === PI.cache.user.id) || null;
}

/* Scores are computed by the database, so a local adjustment is no
   longer needed — the old effectiveScore() added the viewer's own
   vote on top of a stored number. Kept as a pass-through so
   existing calls keep working. */
function effectiveScore(p) { return p.score || 0; }

/* The old forum seeded itself with demo posts. Empty now: the
   feed shows what real people actually wrote. */
const SEED = [];
const SEED_COMMENTS = {};
