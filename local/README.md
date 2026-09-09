# local/

Machine-local files for the co-located dev VM. Everything here except this
README and the `*.example` files is gitignored. The checkout is mounted into
the guest, so these survive a `vagrant destroy` / rebuild, which is the point.

| File | Read by | Purpose |
|---|---|---|
| `stripe.env` | daemon `instance-launch` role, Workers runtime only | Seeds `/etc/turbopanel/instance/.stripe_secret_key` and `.stripe_webhook_signing_secret` on every converge, which the Workers dev vars then carry. Sandbox values only. |
| `tiers.json` | dev overlay role `dev-tier-catalogue`, Workers runtime only | The billing tier catalogue as a superadmin bound it under Admin → Tiers (each ladder label → a Stripe product). Written by the dev console (Developer → **Save tier catalogue**); restored on converge only when the database holds no **priced** tier row, so a reset or rebuild does not mean picking eight products again. The unpriced `SX` row is excluded from that test and skipped by the restore: a self-hosted (deno) instance creates it on its own for the licence grant (turbopanel `src/lib/tiers/self-hosted-grant.ts`), and testing the whole table would mean a database that had ever run in deno mode never restored its bindings. It mirrors the `tier` table's columns verbatim (`insert … select *`), so after a schema change to that table delete it and save again. Never edited by hand. |

Copy `stripe.env.example` to `stripe.env` and fill it in. A Deno instance never
reads it: self-hosted has no billing.
