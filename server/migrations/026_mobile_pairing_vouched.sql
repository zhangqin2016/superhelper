-- Mobile Command — desktop-vouched pairing (phone needs no account login).
--
-- The Phase 1 pairing required the mobile to be logged into the SAME account as
-- the desktop (a mobile user_session + a composite anti-drift FK). That made the
-- phone do its own SMS login — which is impossible abroad (the SMS provider is
-- China-only and region-gated). The trust is redundant anyway: the desktop is
-- already authenticated and must explicitly APPROVE each pairing.
--
-- New model: the phone consumes the one-time QR token with just a browser device
-- id (no account). The desktop user's approval is the gate; the grant's user_id
-- is the desktop (challenge) user, who vouches for the phone. So a grant may have
-- no mobile session.
--
-- Additive + reversible: relax the mobile-session coupling only. Desktop-side
-- integrity (license_device FK, desktop_device FK, no-self-pair, state checks)
-- is untouched. Existing account-authenticated grants remain valid (their
-- account_session_id simply stays populated).

alter table mobile_pairing_grants
  drop constraint if exists mobile_pairing_grants_session_fk;

alter table mobile_pairing_grants
  alter column account_session_id drop not null;
