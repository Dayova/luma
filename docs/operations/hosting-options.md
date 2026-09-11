# Hosting options for the four-founder Luma deployment

Researched 2026-09-11 against official provider pages. This is a recommendation,
not a purchase, a deployed host, or a capacity benchmark. Hosting, backups and
monitoring are separate from the provisional USD 30/month AI usage limit.

My recommendation is **Hetzner Cloud CX23, x86, in Nuremberg,
with a public IPv4 address**. Budget **approximately EUR 11–14/month** for the
server, optional provider backup and an initial EUR 3–5 reserve for independent
backup storage and verification traffic. The arithmetic and limits are below.
This is a modest starting configuration; its production acceptance must prove
that 4 GB RAM and 40 GB disk leave enough room for Luma and its recovery jobs.

## Comparable entry plans

German gross prices include 19% VAT where stated. DigitalOcean remains in USD;
no exchange rate is assumed. The actual business invoice can differ with account
tax treatment. DigitalOcean explicitly excludes VAT from published prices and
lists Germany at 19% in its [EU billing guide](https://docs.digitalocean.com/platform/billing/taxes/eu/).

| Provider and plan          | Resources                                     | Observed price and commitment                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hetzner CX23               | 2 shared vCPU, 4 GB RAM, 40 GB disk           | EUR 6.53/month gross, plus approximately EUR 0.60 for IPv4: **EUR 7.13/month**. Hourly billing with a monthly cap; no annual commitment. [Current June 2026 price list](https://docs.hetzner.com/de/general/infrastructure-and-availability/price-adjustment/), [specifications](https://www.hetzner.com/de/news/new-cloud-plans/), [IPv4](https://docs.hetzner.com/de/general/infrastructure-and-availability/ipv4-pricing/), [billing](https://docs.hetzner.com/cloud/billing/faq/). |
| netcup VPS 500 G12         | 2 vCore, 4 GB RAM, 128 GB NVMe, IPv4 included | **EUR 5.91/month gross** is the default **12-month term and billing period**, with automatic European location selection. Displayed options add EUR 0.90 for zero-month commitment and EUR 0.90 for Nuremberg: **EUR 7.71/month implied by those options**, subject to the final configured quote. [Product configuration](https://www.netcup.com/de/server/vps/vps-500-g12-12m).                                                                                                      |
| OVHcloud VPS-1             | 2 vCore, 4 GB RAM, 40 GB NVMe, IPv4 included  | **From EUR 4.53/month gross**. The current German page labels this range “VPS 2027”; its purchase link selects `pricing=upfront12`. Treat it as an advertised annual-prepayment offer, **not a verified cancellable monthly price**. [Offer](https://www.ovhcloud.com/de/vps/), [linked configuration](https://www.ovhcloud.com/de/vps/configurator/?brick=VPS%2BModel%2B1&planCode=vps-2027-model1&pricing=upfront12&processor=+&storage=40__SSD__NVMe&vcore=2__vCore).               |
| DigitalOcean Basic Regular | 2 shared vCPU, 4 GiB RAM, 80 GiB SSD          | **USD 24/month before VAT**, or USD 28.56 with 19% VAT. Per-second billing, with a minimum charge and monthly cap; no annual commitment. Frankfurt is an available region. [Pricing](https://www.digitalocean.com/pricing/droplets), [regions](https://docs.digitalocean.com/platform/regional-availability/).                                                                                                                                                                         |

The netcup headline is especially easy to miscompare: its cheapest location may
be in Austria, Germany or the Netherlands. Select Nuremberg explicitly if Germany
is required. Its public listing also offers hourly VPS billing; confirm the
selected zero-term tariff and final billing rules before ordering.
[Configuration](https://www.netcup.com/de/server/vps/vps-500-g12-12m),
[VPS plans and terms](https://www.netcup.com/de/server/vps).

## What we give up compared with DigitalOcean

**netcup:** considerably more disk for the money, but contract and location choices
need care. Its documented snapshot workflow is less convenient as a recurring
independent backup: offline snapshots are exportable, online snapshots are not,
and only one export is included free. We already have an application-owned backup
job, so this is manageable. [Snapshot documentation](https://www.netcup.com/en/helpcenter/documentation/server/media).

**OVHcloud:** attractive advertised pricing and a daily backup included. Standard
retention is only 24 hours; Premium keeps seven rolling days. Both use separate
servers in the **same data centre**, and neither includes additional disks.
Independent recovery storage is still necessary. Upgrades retain the location;
downgrades require migration to another offer. The unverified monthly quote is
the main reason I would not select its annual headline offer during exploration.
[Backup details](https://www.ovhcloud.com/en/vps/vps-backup/),
[upgrade and location rules](https://www.ovhcloud.com/de/vps/).

**Hetzner:** a smaller system disk than the alternatives and shared CPU capacity
on its cost-optimized range. CPU contention remains possible; DigitalOcean Basic
also uses shared CPU, so price alone does not establish a performance winner.
[Hetzner server classes](https://docs.hetzner.com/cloud/servers/overview/),
[DigitalOcean plan guidance](https://docs.digitalocean.com/products/droplets/concepts/choosing-a-plan/).
Hetzner's backup add-on costs 20% of the server price, approximately EUR 1.31/month
gross here. Those daily backups have seven slots and disappear when the server
is deleted. Live snapshots are not guaranteed consistent, and attached volumes
are excluded. [Backup billing](https://docs.hetzner.com/cloud/billing/faq/),
[recovery constraints](https://docs.hetzner.com/cloud/servers/backups-snapshots/faq/).

**DigitalOcean:** its integrated backups are convenient, but weekly backups add
20% and daily backups add 30%. The 4 GiB plan with daily backups is therefore
USD 31.20 before VAT, approximately USD 37.13 with 19% VAT, before independent
storage. I do not see a requirement in Luma's present deployment that justifies
that premium. This is a fit judgment, not a claim about relative support quality
or measured reliability. [Droplet and backup pricing](https://www.digitalocean.com/pricing/droplets).

## Backup budget and capacity

Backblaze B2 in EU Central is a concrete independent storage candidate. Its current
pay-as-you-go rate is USD 6.95/TB per 30 days, with the first 10 GB free and free
egress up to three times average stored data; excess egress is USD 0.01/GB.
For example, 100 GB stored for a month is approximately USD 0.63 before tax and
excess downloads. EU Central stores data in Amsterdam at the same storage rate;
the account's region is fixed at creation.
[Pricing](https://www.backblaze.com/cloud-storage/pricing),
[region rules](https://www.backblaze.com/docs/cloud-storage-data-regions).

The EUR 3–5 backup allowance is a reserve, not a provider cap. Luma downloads and
verifies each daily backup, so measure **stored bytes plus verification downloads**.
Retained snapshots grow over time; the current job does not prune them. Configure
cost alerts and inspect the first bill. Domain registration and any paid external
heartbeat service are additional, if needed.

If acceptance shows insufficient headroom, **CX33 with 8 GB RAM and 80 GB disk**
costs approximately EUR 10.70/month gross including IPv4. With its optional 20%
backup add-on and the same reserve, budget approximately **EUR 16–18/month**.
[Specifications](https://www.hetzner.com/cloud/cost-optimized/),
[current prices](https://docs.hetzner.com/de/general/infrastructure-and-availability/price-adjustment/).

## Deployment fit and remaining proof

Luma's [production profile](production-discord.md) needs one always-on Linux host,
Node.js 24, systemd, local persistent PGlite storage, outbound Discord connectivity
and HTTPS for enabled callback/MCP endpoints. These are ordinary VPS capabilities;
we still own OS updates, TLS, monitoring and recovery on every option. Multiple
replicas must not open this store. Run builds and CI separately from the live
small instance.

Use the repository's [cold backup and restore procedure](backup-restore.md) and
[unattended operations](unattended-operations.md): stop admission, drain work,
close cleanly, copy the complete store and required recovery material, restart,
then upload and verify the encrypted off-host backup. Keep its decryption password
in independent custody. Provider snapshots supplement this process. A host failure
still causes an outage while the single instance is restored.

Before activation, verify the selected region's final price, availability and
cancellation terms, then record actual peak memory, disk usage, backup pause,
restore time, restart behaviour and external outage-alert delivery. No provider
load or restore rehearsal was performed for this research, and no host or backup
account has been created.
