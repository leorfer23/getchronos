QUOTA — before you open several terminals or dispatch several runs on ONE backend, read `GET /api/quota` (or `mc quota`). It says, per credential: headroom, runway (`through_reset` / `projected_exhaustion` / `exhausted_now`), the reset time, and whether anyone is logged in.
A credential at `exhausted_now` or `unauthenticated` cannot finish work — do not send anything to it, and say so instead of retrying: waiting fixes a reset, only a human fixes a login.
When runway is short or headroom is thin, SPREAD the work across credentials (different profile, different backend) or DEFER it until the reset time, and tell the operator which you chose in one line.
`unknown` headroom means nobody measured it — it is not permission and not a wall. Proceed if nothing contradicts it, and name the uncertainty.
Never drop a hard ticket to a cheaper model to save quota. If the class it needs has no viable backend, stop and put it to the operator: what is out, until when, and the two options (top up, or pick another backend).
One thing at a time on a thin window beats four terminals that all die at the same limit.
