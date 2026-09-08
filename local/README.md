# local/

Machine-local files for the co-located dev VM. Everything here except this
README and the `*.example` files is gitignored. The checkout is mounted into
the guest, so these survive a `vagrant destroy` / rebuild, which is the point.

| File | Read by | Purpose |
|---|---|---|
| `stripe.env` | daemon `instance-launch` role, Workers runtime only | Seeds `/etc/turbopanel/instance/.stripe_secret_key` and `.stripe_webhook_signing_secret` on every converge, which the Workers dev vars then carry. Sandbox values only. |
| `tiers.json` | dev overlay role `dev-tier-catalogue`, Workers runtime only | The billing tier catalogue as a superadmin entered it through Admin → Tiers. Written by the dev console (Developer → **Save tier catalogue**); restored on converge only when the tier table is empty, so a reset or rebuild does not mean re-entering seven tiers. Never edited by hand. |

Copy `stripe.env.example` to `stripe.env` and fill it in. A Deno instance never
reads it: self-hosted has no billing.
