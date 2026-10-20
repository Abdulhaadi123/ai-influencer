-- ═════════════════════════════════════════════════════════════════════════════
-- 008 — a session belongs to one place: the app or the admin panel
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Until now a session meant only "this account is signed in". An administrator who signed in on a
-- phone therefore held a token that also worked on /api/admin/*, and an administrator could use the
-- app as an ordinary user. Staff accounts and app accounts are now kept apart:
--
--   scope 'app'    works on the app's endpoints, and only for an account that is not an administrator
--   scope 'admin'  works on /api/admin/*, and only for an administrator
--
-- Which one a sign-in gets is decided when the person signs in (api/auth/account.js signIn) and the
-- session keeps it through every refresh. The role is still read from the users row on every call,
-- so promoting or demoting someone changes what their sessions may do at once.
--
-- Every existing session becomes an 'app' session. An administrator signs in to the panel again once
-- after this ships; their old token is refused with "sign in to the admin panel".

alter table sessions
  add column scope text not null default 'app',
  add constraint sessions_scope_check check (scope in ('app', 'admin'));
