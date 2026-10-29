# Consultant Inspector integration

The existing Session Inspector CLI exposes the worker consultation commands described in
[consultant-api.md](consultant-api.md): list consultants, ask one consultant, and
call a round table. These commands consume `/api/consultants`; they do not call
worker orchestration or create tasks.

The session view has no separate Consultants tab. Consultation is available
through the Session Inspector CLI without a session-view UI or Side chat.

## Integration verification

- 50 passing tests across consultant service, actor type mapping, Session Inspector
  CLI and navigation. CLI tests run with inherited Threadex role variables removed;
  each fixture establishes its own identity. These cover both worker triggers,
  active capability binding, model permissions, signed-in HTTP, cross-session
  rejection, lifecycle and existing Inspector commands.
- Shell/Settings/actor navigation browser tests verify Agent actors separation and
  editing/navigation, actor deep links, actor sessions and phone navigation. Legacy
  consultant and worker identities remain in their separate registries, including
  equal IDs.
- Typecheck and targeted whitespace checks pass.

Local listener tests require permitted loopback access. Initial sandbox listener
failures were resolved by running those tests with that access. Initial CLI role
failures were resolved through environment isolation. The new shell test fixture
was completed with the required session cwd and Side chat response contract.

No real provider inference, deployment, commit or production settings mutation
was performed. Automated provider output verifies integration and lifecycle; it
does not establish live account/provider availability.
