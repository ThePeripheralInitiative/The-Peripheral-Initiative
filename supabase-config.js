/* ============================================================
   THE PERIPHERAL INITIATIVE — Supabase client & shared helpers
   v2 — password auth + stay-signed-in
   ------------------------------------------------------------
   Load on every page needing auth, AFTER the Supabase CDN script
   and BEFORE your page logic:

     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="supabase-config.js"></script>

   ------------------------------------------------------------
   ABOUT THE KEY BELOW

   The anon key is MEANT to be public. It is not a password and not
   a secret — it identifies your project and nothing more. Every
   Supabase site ships it in client code, which is why static
   GitHub Pages hosting works fine.

   What protects your data is Row Level Security in the database.
   Someone holding this key still cannot read a private track,
   promote themselves to owner, or verify their own artist page.

   NEVER put the service_role key in this file or anywhere in your
   repository. It bypasses RLS entirely and belongs only in
   server-side Edge Functions.
   ============================================================ */

/* ------------------------------------------------------------
   Declared FIRST, before any code that could throw.

   Reason: if these lived further down and an earlier line failed,
   the binding would not exist at all — and then a page checking
   `if (!sb)` throws ReferenceError instead of showing its error
   message. The safety check would become the crash. That happened.
   ------------------------------------------------------------ */
let sb = null;
let SUPABASE_CONFIG_ERROR = null;
const PERIPHERAL_CONFIG_LOADED = true;   // pages test for this


const SUPABASE_URL      = 'https://rwcxmcmrkzcbrgbjcvwy.supabase.co';
// Paste your publishable key between the quotes below. Use the copy
// button in the dashboard — the on-screen version is truncated with an
// ellipsis, and a hand-selected partial key fails in a confusing way.
const SUPABASE_ANON_KEY = 'PASTE_PUBLISHABLE_KEY_HERE';


/* ------------------------------------------------------------
   STAY SIGNED IN

   Supabase keeps people signed in by default — sessions persist and
   refresh automatically. So "stay signed in" is not something we
   add; it is something we let people TURN OFF.

   The switch is which storage the session lives in:

     localStorage    survives closing the browser  -> stays signed in
     sessionStorage  dies when the tab closes      -> signed out

   The adapter below decides per write, reading the preference each
   time rather than at page load. That matters because the checkbox
   is ticked after this client is created — a choice fixed at
   startup would always be stale.

   Only the preference itself lives permanently in localStorage.
   Never the session.
   ------------------------------------------------------------ */

const PERSIST_KEY = 'pi_stay_signed_in';

function staySignedIn() {
  try { return localStorage.getItem(PERSIST_KEY) !== 'false'; }
  catch (e) { return true; }
}

function setStaySignedIn(on) {
  try { localStorage.setItem(PERSIST_KEY, on ? 'true' : 'false'); } catch (e) {}
}

const dynamicSessionStorage = {
  getItem(key) {
    try {
      const fromLocal = localStorage.getItem(key);
      if (fromLocal !== null) return fromLocal;
      return sessionStorage.getItem(key);
    } catch (e) { return null; }
  },
  setItem(key, value) {
    try {
      if (staySignedIn()) {
        localStorage.setItem(key, value);
        sessionStorage.removeItem(key);
      } else {
        sessionStorage.setItem(key, value);
        localStorage.removeItem(key);
      }
    } catch (e) {}
  },
  removeItem(key) {
    // Always clear both, so a session can never be orphaned in one store.
    try { localStorage.removeItem(key); } catch (e) {}
    try { sessionStorage.removeItem(key); } catch (e) {}
  }
};




/* ------------------------------------------------------------
   PHONE VERIFICATION FLAG

   Supabase does not include SMS delivery. Unlike email, phone
   verification requires connecting your own provider (Twilio and
   similar) and paying per message. The code paths exist below but
   stay switched off so nobody is offered an option that silently
   fails.

   Flip to true after configuring a provider under
   Authentication > Sign In / Providers > Phone.
   ------------------------------------------------------------ */
const PHONE_AUTH_ENABLED = false;


/* ------------------------------------------------------------
   SOCIAL SIGN-IN FLAG

   Apple and Google buttons are built and ready, but hidden until
   each provider is actually configured in the dashboard.

   The reason to hide rather than show-and-fail: a button that
   errors reads as a broken site to someone who has no idea the
   provider was never set up. Better to offer two working options
   than four options where two are landmines.

   To turn on:
     Google — free. Google Cloud project + OAuth client + consent
              screen. Note the consent screen needs verification
              before it works for the general public; unverified
              apps warn the user and cap the audience.
     Apple  — requires Apple Developer Program membership
              ($99/year). Worth doing when the iOS app needs it
              anyway, not before.

   Then: Authentication > Sign In / Providers, enable the provider,
   paste its client id and secret, and flip this to true.
   ------------------------------------------------------------ */
const OAUTH_ENABLED = false;


/* ------------------------------------------------------------
   PASSWORD RULES

   IMPORTANT: this is convenience, not enforcement. It runs in the
   browser and can be bypassed. Set the real minimum in the
   dashboard under Authentication > Sign In / Providers > Email >
   Minimum password length. Supabase defaults to 6, which is too
   low — raise it to 10 to match this.

   Length is weighted over character-class gymnastics on purpose:
   a long passphrase beats a short scramble, and forcing symbols
   mostly produces "Password1!" and a sticky note.
   ------------------------------------------------------------ */
const MIN_PASSWORD_LENGTH = 10;

const WEAK_PASSWORDS = [
  'password','password1','12345678','123456789','1234567890','qwertyuiop',
  'letmein','iloveyou','welcome1','admin123','peripheral','theperipheral'
];

/* Mirrors the dashboard setting:
   Authentication > Sign In / Providers > Email > Password requirements
   = "Lowercase, uppercase letters, digits and symbols".

   These two MUST agree. If the browser is more permissive than the
   server, someone sees "Strong password", hits Continue, and gets
   rejected — with the failure appearing at the wrong step. If the
   browser is stricter, valid passwords get refused for no reason.

   Change one, change the other. */
const SYMBOLS = "!@#$%^&*()_+\\-=\\[\\]{};':\"\\\\|<>?,./`~";

function passwordProblem(pw) {
  if (!pw) return 'Enter a password.';
  if (pw.length < MIN_PASSWORD_LENGTH) return `At least ${MIN_PASSWORD_LENGTH} characters.`;
  if (pw.length > 72) return 'Too long — 72 characters maximum.';
  if (/^\s|\s$/.test(pw)) return 'Cannot start or end with a space.';

  if (!/[a-z]/.test(pw)) return 'Needs at least one lowercase letter.';
  if (!/[A-Z]/.test(pw)) return 'Needs at least one uppercase letter.';
  if (!/[0-9]/.test(pw)) return 'Needs at least one number.';
  if (!new RegExp('[' + SYMBOLS + ']').test(pw)) {
    return 'Needs at least one symbol, such as ! ? @ # or -';
  }

  const flat = pw.toLowerCase().replace(/[^a-z0-9]/g,'');
  if (WEAK_PASSWORDS.some(w => flat === w || flat.includes(w))) {
    return 'Too common — pick something less guessable.';
  }
  if (/^(.)\1+$/.test(pw)) return 'Cannot be a single repeated character.';
  return null;
}

/* 0-4, for the strength bar. Everything reaching here already meets
   the character rules, so this only rewards extra length. */
function passwordStrength(pw) {
  if (!pw) return 0;
  let score = 1;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  if (pw.length >= 20) score++;
  return Math.min(score, 4);
}

const STRENGTH_LABEL = ['', 'Weak', 'Fair', 'Good', 'Strong'];
const STRENGTH_COLOR = [
  'var(--decay)', 'var(--danger)', 'var(--gold)', 'var(--matrix)', 'var(--matrix)'
];


/* ------------------------------------------------------------
   Username rules — client-side half.

   Courtesy check for fast typing feedback. NOT the enforcement
   layer: the unique index on lower(username) in the database is
   what actually guarantees no collisions.

   Real hate-speech filtering belongs in a maintained moderation
   service, not a hardcoded list. This covers impersonation only.
   ------------------------------------------------------------ */
const RESERVED_NAMES = [
  'admin','administrator','moderator','mod','staff','official',
  'peripheral','peripheralteam','theperipheralinitiative','support','owner'
];

function normalizeName(s) {
  return s.toLowerCase()
    .replace(/1/g,'i').replace(/0/g,'o').replace(/3/g,'e')
    .replace(/4/g,'a').replace(/5/g,'s').replace(/7/g,'t')
    .replace(/[^a-z]/g,'');
}

function localUsernameProblem(raw) {
  const t = raw.trim();
  if (t.length < 3)  return 'Too short — at least 3 characters.';
  if (t.length > 20) return 'Too long — 20 characters maximum.';
  if (!/^[A-Za-z0-9_]+$/.test(t)) return 'Letters, numbers, and underscores only.';
  if (RESERVED_NAMES.some(n => normalizeName(t).includes(n))) return "That name isn't available.";
  return null;
}

async function usernameIsFree(name) {
  const { data, error } = await sb
    .from('profiles')
    .select('username')
    .ilike('username', name.trim())
    .limit(1);
  if (error) throw error;
  return data.length === 0;
}


/* ------------------------------------------------------------
   Identity helpers
   ------------------------------------------------------------ */
function looksLikeEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

function looksLikePhone(v) {
  return /^\+?[0-9\s\-().]{7,}$/.test(v.trim());
}

/* E.164 is what Supabase expects: +15550001234 */
function toE164(v) {
  const digits = v.replace(/[^\d]/g, '');
  if (v.trim().startsWith('+')) return '+' + digits;
  if (digits.length === 10)     return '+1' + digits;   // assume US on a bare 10 digits
  return '+' + digits;
}


/* ------------------------------------------------------------
   Session & profile
   ------------------------------------------------------------ */
async function currentUser() {
  const { data } = await sb.auth.getUser();
  return data?.user || null;
}

/* Returns the profile row, or null when the account is
   authenticated but has not finished choosing a username. That
   second state is real and easy to hit — someone can close the tab
   between confirming their email and picking a name. */
async function currentProfile() {
  const user = await currentUser();
  if (!user) return null;
  const { data, error } = await sb
    .from('profiles')
    .select('id, username, role, is_banned')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function signOut() {
  await sb.auth.signOut();
  clearLegacyLocalStorage();
  window.location.href = 'home.html';
}

/* The prototype kept auth state in localStorage. Those keys are now
   meaningless, and a stale pi_role left behind would be confusing.
   Clear them on any auth transition. */
function clearLegacyLocalStorage() {
  ['pi_verified','pi_alias','pi_identity','pi_role','pi_registered']
    .forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
}


/* ------------------------------------------------------------
   Error text — Supabase messages are developer-facing. Translate
   the common ones into something a person can act on.
   ------------------------------------------------------------ */
function friendlyAuthError(error) {
  const m = (error?.message || '').toLowerCase();
  if (m.includes('rate limit') || m.includes('too many'))
    return 'Too many attempts. Wait a minute and try again.';
  if (m.includes('invalid login credentials'))
    return 'That email and password combination is not correct.';
  if (m.includes('email not confirmed'))
    return 'This email has not been confirmed yet. Check your inbox for the code.';
  if (m.includes('already registered') || m.includes('already exists'))
    return 'An account already exists for that email. Try logging in instead.';
  if (m.includes('invalid') && m.includes('token'))
    return 'That code is incorrect or has expired. Request a new one.';
  if (m.includes('expired'))
    return 'That code has expired. Request a new one.';
  if (m.includes('password') && m.includes('short'))
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (m.includes('email') && m.includes('invalid'))
    return "That email address doesn't look right.";
  if (m.includes('signups not allowed') || m.includes('disabled'))
    return 'New sign-ups are currently closed.';
  return error?.message || 'Something went wrong. Try again.';
}


/* ============================================================
   CLIENT CREATION — deliberately the LAST thing in this file.

   Everything above is plain constants and functions that cannot
   fail. createClient CAN fail: bad URL, missing key, CDN not
   loaded. In JavaScript a thrown error stops the whole file, so
   anything declared after it would silently not exist.

   That is not a theoretical problem — it produced a real bug where
   signup rendered step 1 fine, then froze on Continue, because
   OAUTH_ENABLED had never been defined. No visible error, just a
   dead button.

   Constants first, risky call last, with a check that says
   plainly what is wrong.
   ============================================================ */

(function initClient() {
  if (typeof window.supabase === 'undefined') {
    SUPABASE_CONFIG_ERROR =
      'The Supabase library did not load. Check your connection and reload.';
    console.error('[Peripheral] supabase-js not found. Is the CDN <script> tag present and reachable?');
    return;
  }

  if (!SUPABASE_URL || SUPABASE_URL.startsWith('PASTE_')) {
    SUPABASE_CONFIG_ERROR =
      'This site is not finished connecting to its database yet.';
    console.error('[Peripheral] SUPABASE_URL is still the placeholder. Paste your Project URL from Settings > API.');
    return;
  }

  if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.startsWith('PASTE_')) {
    SUPABASE_CONFIG_ERROR =
      'This site is not finished connecting to its database yet.';
    console.error('[Peripheral] SUPABASE_ANON_KEY is still the placeholder. Paste your anon public key from Settings > API.');
    return;
  }

  try {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: dynamicSessionStorage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,  // required for password-reset and OAuth returns

        /* PKCE instead of the implicit flow.
           Implicit puts access tokens directly in the URL fragment, where
           they land in browser history and can leak via the Referer header.
           PKCE sends a single-use code that is exchanged for the session,
           so no token is ever sitting in the address bar. */
        flowType: 'pkce'
      }
    });
  } catch (e) {
    SUPABASE_CONFIG_ERROR = 'Could not connect to the database.';
    console.error('[Peripheral] createClient failed:', e);
  }
})();
