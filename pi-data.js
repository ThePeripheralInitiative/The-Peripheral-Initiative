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

  function shapePost(row, scoreMap) {
    return {
      id:        row.id,
      genre:     row.genre,
      title:     row.title,
      body:      row.body || '',
      alias:     row.profiles ? row.profiles.username : '[deleted]',
      authorId:  row.author_id,
      timestamp: new Date(row.created_at).getTime(),
      score:     scoreMap[row.id] || 0,
      removed:   row.is_removed
    };
  }

  function shapeComment(row) {
    return {
      id:        row.id,
      postId:    row.post_id,
      body:      row.body,
      alias:     row.profiles ? row.profiles.username : '[deleted]',
      authorId:  row.author_id,
      timestamp: new Date(row.created_at).getTime(),
      removed:   row.is_removed
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
        .select('id, author_id, genre, title, body, is_removed, created_at, profiles!posts_author_id_fkey(username)')
        .eq('is_removed', false)
        .order('created_at', { ascending: false }),

      sb.from('post_scores').select('post_id, score'),

      sb.from('comments')
        .select('id, post_id, author_id, body, is_removed, created_at, profiles!comments_author_id_fkey(username)')
        .eq('is_removed', false)
        .order('created_at', { ascending: true }),

      sb.from('pages')
        .select('id, owner_id, kind, name, bio, links, verification')
        .order('created_at', { ascending: true })
    ];

    if (signedIn) {
      queries.push(
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

    const [postsRes, scoresRes, commentsRes, pagesRes,
           profileRes, votesRes, cvotesRes, savesRes] = results;

    /* Report every failed query by name.
       Without this, a query that errors and a table that is genuinely
       empty produce the same thing: an empty array and a silent UI.
       That ambiguity cost real debugging time, so failures are now
       loud. */
    const named = [
      ['posts', postsRes], ['post_scores', scoresRes],
      ['comments', commentsRes], ['pages', pagesRes],
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

    cache.comments = {};
    if (commentsRes && !commentsRes.error && commentsRes.data) {
      commentsRes.data.forEach(r => {
        if (!cache.comments[r.post_id]) cache.comments[r.post_id] = [];
        cache.comments[r.post_id].push(shapeComment(r));
      });
    }

    cache.pages = {};
    if (pagesRes && !pagesRes.error && pagesRes.data) {
      pagesRes.data.forEach(r => { cache.pages[r.id] = shapePage(r); });
    }

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
        .select('id, author_id, genre, title, body, is_removed, created_at, profiles!posts_author_id_fkey(username)')
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
    const { data, error } = await sb.from('comments')
      .select('id, post_id, author_id, body, is_removed, created_at, profiles!comments_author_id_fkey(username)')
      .eq('post_id', postId)
      .eq('is_removed', false)
      .order('created_at', { ascending: true });
    if (!error) cache.comments[postId] = (data || []).map(shapeComment);
  }

  async function refreshPages() {
    const { data, error } = await sb.from('pages')
      .select('id, owner_id, kind, name, bio, links, verification')
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
    createPage, updatePage, setPageVerification, deletePage,
    signOut
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
