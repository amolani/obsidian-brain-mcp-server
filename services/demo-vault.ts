import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DemoVaultOptions {
  outPath: string
  force?: boolean
}

export interface DemoVaultResult {
  outPath: string
  files: string[]
}

const DEMO_DATE = '2026-05-12'

function write(outPath: string, files: string[], relativePath: string, content: string): void {
  const fullPath = join(outPath, relativePath)
  mkdirSync(join(fullPath, '..'), { recursive: true })
  writeFileSync(fullPath, content, 'utf-8')
  files.push(relativePath)
}

function ensureWritableTarget(outPath: string, force: boolean): void {
  if (!existsSync(outPath)) return
  const entries = readdirSync(outPath)
  if (entries.length > 0 && !force) {
    throw new Error(`${outPath} existiert bereits und ist nicht leer. Nutze --force fuer eine neue Demo.`)
  }
  if (force) rmSync(outPath, { recursive: true, force: true })
}

export function createDemoVault(options: DemoVaultOptions): DemoVaultResult {
  if (!options.outPath?.trim()) throw new Error('outPath ist erforderlich')
  ensureWritableTarget(options.outPath, options.force === true)
  mkdirSync(options.outPath, { recursive: true })

  const files: string[] = []

  write(options.outPath, files, 'Daily/2026-05-12.md', `---
status: aktiv
tags:
  - daily
datum: ${DEMO_DATE}
---

# ${DEMO_DATE}

## Aufgaben

- [ ] DHCP-Fix im Kunden-Snapshot verlinken
- [x] Firewall-Dienst nach Konfiguration validieren

## Gelernt

- Claude Code Session wurde automatisch als Knowledge Capture abgelegt.
`)

  write(options.outPath, files, 'Kunden/Acme-Schule/Captures/2026-05-12 Firewall DHCP Fix.md', `---
status: aktiv
tags:
  - auto-capture
  - prozedur
  - firewall
  - dhcp
datum: ${DEMO_DATE}
quelle: knowledge-harvester
confidence: medium
---

# Firewall DHCP Fix

## Zusammenfassung

Die Clients im Verwaltungsnetz bekamen keine Lease, weil der DHCP-Dienst auf der Firewall nicht aktiv war und der Relay auf einen alten Server zeigte.

## Durchgeführte Befehle

1. \`ssh firewall.acme.example\`
2. \`systemctl status isc-dhcp-server\`
3. \`grep -R "dhcp-relay" /etc/network/\`
4. \`systemctl enable --now isc-dhcp-server\`
5. \`journalctl -u isc-dhcp-server -n 80\`

## Validierung

- Test-Client erhielt Lease aus dem Verwaltungsnetz.
- Firewall-Log zeigte keine weiteren DHCP-Fehler.
- Alter Relay-Eintrag wurde dokumentiert.

## Fehler und Workarounds

### 1. Dienst startet nicht
Konfiguration mit \`dhcpd -t\` pruefen und fehlende Subnet-Definition ergaenzen.

### 2. Client bekommt weiter keine Lease
VLAN-Tagging am Switch-Port und Firewall-Interface gegenpruefen.
`)

  write(options.outPath, files, 'Kunden/Acme-Schule/_timeline.md', `---
status: aktiv
tags:
  - customer-timeline
datum: ${DEMO_DATE}
quelle: demo
---

# Acme-Schule Timeline

- ${DEMO_DATE}: DHCP-Incident analysiert und Firewall-Dienst wieder aktiviert.
`)

  write(options.outPath, files, 'Kunden/Acme-Schule/_snapshot.md', `---
status: aktiv
tags:
  - customer-snapshot
datum: ${DEMO_DATE}
quelle: demo
---

# Acme-Schule Snapshot

## Aktueller Kontext

- Firewall ist verbindliche DHCP-Quelle fuer Verwaltungsnetz.
- Runbook: [[Knowledge/Runbooks/Runbook Firewall DHCP|Runbook Firewall DHCP]]
- Offene Aufgabe: Daily Note nachfuehren.
`)

  write(options.outPath, files, 'Knowledge/Claims/DHCP Quelle Firewall.md', `---
status: aktiv
tags:
  - claim
  - dhcp
datum: ${DEMO_DATE}
confidence: high
quelle: Kunden/Acme-Schule/Captures/2026-05-12 Firewall DHCP Fix.md
checked_at: ${DEMO_DATE}
recheck_at: 2026-08-12
---

# DHCP Quelle Firewall

Die Firewall ist die verbindliche DHCP-Quelle fuer das Verwaltungsnetz der Acme-Schule.
`)

  write(options.outPath, files, 'Knowledge/Runbooks/Runbook Firewall DHCP.md', `---
status: aktiv
tags:
  - runbook
  - dhcp
datum: ${DEMO_DATE}
quelle: demo
confidence: medium
---

# Runbook: Firewall DHCP

## Voraussetzungen

- SSH-Zugriff auf Firewall
- Wartungsfenster oder Freigabe fuer DHCP-Dienst-Neustart

## Schritte

1. Dienststatus pruefen.
2. Konfiguration validieren.
3. Dienst aktivieren oder neu starten.
4. Client-Lease testen.

## Validierung

- Client erhaelt Lease.
- Logs enthalten keine DHCP-Fehler.

## Rollback

- Dienst stoppen und vorherige Relay-Konfiguration wiederherstellen.
`)

  write(options.outPath, files, 'Knowledge/_brain.md', `---
status: aktiv
tags:
  - brain-dashboard
datum: ${DEMO_DATE}
quelle: brain-dashboard
---

# Brain Dashboard

## Operating Review

- Demo-Vault bereit. Starte mit \`brain_health_check\`, \`brain_metrics\` und \`build_capture_review\`.
`)

  write(options.outPath, files, 'Knowledge/index.md', `---
status: aktiv
tags:
  - knowledge-index
datum: ${DEMO_DATE}
quelle: knowledge-index
---

# Knowledge Index

- [[Knowledge/Claims/DHCP Quelle Firewall|DHCP Quelle Firewall]]
- [[Knowledge/Runbooks/Runbook Firewall DHCP|Runbook Firewall DHCP]]
`)

  write(options.outPath, files, 'Knowledge/hot.md', `---
status: aktiv
tags:
  - hot-cache
datum: ${DEMO_DATE}
quelle: hot-cache
---

# Hot Cache

- Acme-Schule: DHCP-Fix und Runbook sind aktuell relevant.
`)

  write(options.outPath, files, 'Maintenance/Auto-Build/2026-05-12 Firewall DHCP Fix.md', `---
status: aktiv
tags:
  - auto-build-report
datum: ${DEMO_DATE}
quelle: brain-auto-build
---

# Auto-Build Report

Quelle: [[Kunden/Acme-Schule/Captures/2026-05-12 Firewall DHCP Fix|Firewall DHCP Fix]]

## Ergebnisse

- Claim extrahiert
- Runbook-Kandidat erkannt
- Customer Snapshot aktualisiert
`)

  write(options.outPath, files, '.raw/tickets/acme-dhcp-incident.md', `# Ticket ACME-2026-0512

- Clients im Verwaltungsnetz bekommen keine DHCP-Lease.
- Firewall soll DHCP bedienen.
- Relay zeigt noch auf alten Server.
`)

  write(options.outPath, files, '.brain-auto-build-manifest.json', `${JSON.stringify({
    version: 1,
    sources: {
      'Kunden/Acme-Schule/Captures/2026-05-12 Firewall DHCP Fix.md': {
        sourcePath: 'Kunden/Acme-Schule/Captures/2026-05-12 Firewall DHCP Fix.md',
        hash: 'demo',
        promotedAt: `${DEMO_DATE}T12:00:00.000Z`,
        artifacts: [
          'Knowledge/Claims/DHCP Quelle Firewall.md',
          'Knowledge/Runbooks/Runbook Firewall DHCP.md',
        ],
        reportPath: 'Maintenance/Auto-Build/2026-05-12 Firewall DHCP Fix.md',
      },
    },
  }, null, 2)}\n`)

  write(options.outPath, files, '.action-log.jsonl', `${JSON.stringify({
    ts: `${DEMO_DATE}T12:00:00.000Z`,
    tool: 'demo_vault',
    mode: 'apply',
    targets: ['Knowledge/_brain.md'],
    summary: 'Synthetic demo vault generated',
  })}\n`)

  return { outPath: options.outPath, files }
}
