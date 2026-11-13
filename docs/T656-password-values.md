# T656: password values in page reads

Snapshot values were serialized without regard to input type. The server's credential
redactor only recognizes structured keys/tokens; arbitrary passwords have no reliable
pattern, so its existing stub tests could not catch this incident.

Snapshots now omit input and textarea values (and textarea source text), including
fields revealed before the first inspection. This intentionally also omits ordinary
text inputs: current type cannot establish whether a field held a password.
find_by_text consumes the same snapshot. get_page_text reads rendered text, not input
properties. Readability removes inputs/textareas from its document clone.
The evaluator scrubs exact input values captured before and after execution from
serialized results and errors, including open shadow roots. It is not a security
sandbox: arbitrary scripts can transform/encode a secret or read another frame.
Do not use evaluation to retrieve credentials.

Regression: build then `node scripts/probe-password-values.mjs` runs the actual bundles
in a disposable headless Chrome profile with fake prefilled/revealed passwords.
The existing live probes were updated to stop calling retired interactive_elements.

Signing configuration was restored from the laptop to the mini on 2026-11-12,
with mode 0600; it is machine-local configuration, outside this public repository.
AMO authenticated successfully and reported 0.0.26 as its highest signed version.
Release 0.0.27 is the password-value fix. Installation and live verification of
that version are required before completing T656. Live probe results obtained
before installation exercise the previous extension, not these changes.

Installed Zen confirmed extension.version 0.0.27. The live password probe
(`node scripts/probe-password-live.mjs`), probe-snapshot-ids.mjs and probe-redact.mjs
all passed against that installed version on 2026-11-12. Fixture tabs were closed.
The credential-redact suite passed all 15 cases. T656 is ready to close.
