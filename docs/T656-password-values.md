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

Release remains pending: this Mac has no ~/.config/zen-mcp/.env signing credentials,
and secret has reports AMO_KEY/AMO_SECRET absent. No manifest version was guessed:
query AMO, bump past its highest version, rebuild/sign, install and confirm in Zen,
then rerun the password fixture and both live probes. Existing live probe results
before installation exercise the currently installed extension, not these changes.
