# Security deployment and recovery

Run security tests with Node 24: npm run test:security. Run the browser security suite with playwright test tests/e2e/security-hardening-ui.spec.ts. Build with npm run build and check TypeScript with tsc --noEmit. The lockfile includes the official SheetJS 0.20.3 tarball and a DOMPurify override; keep their integrity metadata.

Deploy the profile privileges migration first. Deploy the frontend with the MFA enrollment screen, then apply require_admin_mfa and deploy the five administrative Edge Functions. Config lists verify_jwt=false for these functions because they validate the bearer token with Auth.getUser and check role plus security_has_aal2 themselves. Integration endpoints retain their separate API-key authentication.

Owners and superadministrators must enroll a TOTP authenticator and verify a code. New and reset passwords require 12 characters; existing passwords can still sign in. TOTP is enabled in hosted Auth. Leaked-password protection requires the provider plan to support it; verify that the setting persists instead of assuming a successful toggle enabled it.

The browser keeps the Supabase session in localStorage and reads the TOTP time from the session JWT `amr` claim. The code is asked again, together with the password, 30 days after that claim. This does not change RLS or `security_has_aal2`. In the Supabase Auth dashboard, confirm that a session time-box or inactivity timeout is not shorter than 30 days and that the refresh-token reuse interval is not zero; those settings are not changed from this repo. If they are shorter, a reload can revoke the session even though the app still has the token.

For lost MFA access, the project administrator must verify the person's identity through an independent channel before removing the lost factor in the Supabase dashboard. The user then enrolls again. Never disable the server-side AAL2 requirement or restore broad profile grants as an access workaround. Do not put TOTP seeds or recovery credentials in logs or support tickets.

The designer scopes draft, template and history cache by user and workshop, clears these caches on logout/identity change and discards unattributed legacy cache. Server records are untouched. Workshop owners removing staff now remove only that workshop membership, preserving Auth and other workshops. Privileged or shared accounts require a superadministrator for account mutations.

Rollback: preserve the profile privilege migration and the retired legacy endpoint. If a frontend regression occurs, deploy a compatible fix or a reviewed UI build that retains MFA enrollment; keep the server checks. Do not deploy the old administrative functions, re-enable the legacy endpoint, or restore GRANT ALL. Restore non-security configuration only after checking the saved permissions/functions snapshot and current data. Re-run negative authorization and cross-workshop tests after any recovery.

CSP permits local scripts, inline styles needed by React/html2canvas, Google fonts and maps, HTTPS images, and the configured Supabase project. It forbids external script CDNs, object embeds and foreign framing. Review any new external integration before extending it.
