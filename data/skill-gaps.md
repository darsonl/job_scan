# Skill Gaps Tracker

Consolidated from reports up to 2026-05-08 (#175).
Auto-populated by pipeline. Update frequency column as skills are acquired.

---

## Critical Gaps (High severity, 3+ reports)

| Skill / Tool | Times Flagged | Severity | Status | Notes |
|--------------|---------------|----------|--------|-------|
| **macOS admin / Jamf Pro** | 7 | 🔴 High | Open | Reports: 008, 011, 016, 029, 054, 073, 082. CV is Windows/Linux-dominant. Jamf is the standard MDM for Apple fleets. Intune experience provides partial MDM bridge. |
| **Okta** (admin + APIs + Orchestrator) | 5 | 🔴 High | Open | Reports: 016, 017, 022, 028, 029. Standard identity platform at US tech companies. |
| **Kubernetes** | 5 | 🔴 High | Open | Reports: 001, 007, 013, 014, 017, 025. Homelab Docker doesn't satisfy this requirement at scale. |
| **VMware** (vSphere/ESXi/AHV) | 13 | 🔴 High | Open | Reports: 049, 059, 075, 076, 080, 164, 165, 170, 175 + others. Enterprise hypervisor — homelab Docker/containers are not equivalent. Hyper-V provides partial bridge. |
| **Nutanix HCI** | 2 | 🔴 High | Open | Reports: 170, 175. Hyperconverged infra platform — VAR/SI market staple. Nutanix trial available. New gap 2026-05-08. |
| **Veeam / Commvault backup** | 1 | 🟡 Medium | Open | Report: 170. Enterprise backup/recovery tools. Not in CV. New gap 2026-05-08. |
| **Fortinet ecosystem** (FortiGate, FortiSIEM, EDR integration) | 1 | 🟡 Medium | Open | Report: 188. Enterprise firewall and SIEM platform. Common in Taiwan tech companies with SecOps scope. Free NSE training at training.fortinet.com. New gap 2026-05-09. |
| **ISO 27001 / SOC 2 implementation** | 4 | 🔴 High | Open | Reports: 020, 071, 084, 085. Has conceptual knowledge but no formal implementation/audit-lead experience. |
| **Google Workspace admin** | 4 | 🟡 Medium | Open | Reports: 011, 016, 019, 022, 029. Has O365 admin (transferable). GWS admin is a distinct skill. |
| **Intune / MDM platforms** | 4 | 🟡 Medium | ✅ Covered | Real experience confirmed. Partially mitigates Jamf Pro gap via MDM concept transfer. Removed from learning queue. |
| **CI/CD pipeline ownership** (from scratch) | 3 | 🔴 High | Open | Reports: 001, 014, 017. Used GitLab CI but didn't build pipelines for dev teams. |
| **ERP system implementation** | 4 | 🔴 High | Open | Reports: 058, 069, 070, 081. SAP in CV is admin-level. Functional module impl (SD/MM/FICO) is a distinct competency. |

---

## Moderate Gaps (Medium severity or flagged 1-2 times)

| Skill / Tool | Times Flagged | Severity | Status | Notes |
|--------------|---------------|----------|--------|-------|
| **Azure AD / Entra ID / cloud identity** | 3 | 🟡 Medium | Open | Reports: 017, 026, 027. On-prem AD on CV; cloud identity (SAML, SCIM, OIDC) is increasingly required. |
| **CrowdStrike Falcon** | 1 | 🔴 High | Open | Report: 028. Named specifically for RTR + vulnerability modules. |
| **ZTNA platforms** (Cloudflare Access, Zscaler ZPA) | 1 | 🔴 High | Open | Report: 028. Zero Trust Network Access — distinct from traditional VPN. |
| **Python scripting depth** | 2 | 🟡 Medium | Open | Reports: 016, 017. Uses Python but it's not the most-demonstrated language. |
| **ITSM tooling** (ServiceNow, Jira Service Mgmt) | 3 | 🟡 Medium | Open | Reports: 008, 027, 082. Ticketing concept solid; platform-specific admin is a gap. |
| **MES / LIMS / WMS systems** | 2 | 🔴 High | Open | Reports: 058, 081, 084. Manufacturing/lab systems — specialized domain. |
| **SentinelOne** | 1 | 🟡 Medium | Open | Report: 011. General endpoint security background exists; platform-specific gap. |
| **SLO ownership / on-call rotation** | 1 | 🟡 Medium | Open | Report: 017. No formal SLO ownership or on-call rotation documented. |
| **Enterprise automation platforms** (Workato, n8n, Tines) | 1 | 🔴 High | Open | Report: 017. Workflow automation domain exists but these specific platforms are not in CV. |
| **BGP / OSPF / carrier networking** | 2 | 🔴 High | Open | Reports: 015, 075. Networking generalist; IDC/carrier-grade protocols are a specialist gap. |
| **Ansible** | 3 | 🟡 Medium | Open | Reports: 001, 013, 025. Config management automation gap; Terraform experience shows IaC mindset. |

---

## Structural Gaps (Context-dependent, not skill-learnable)

| Gap | Frequency | Notes |
|-----|-----------|-------|
| **Years of experience shortfall** | 15+ reports | Most JDs require 7-10 years; CV shows ~3-5. Most common in senior/manager roles. |
| **Team management (direct reports)** | 5+ reports | Several roles require 3+ years managing 10+ person teams. |
| **US-based location requirement** | 6+ reports | Remote roles specifying USA timezone or relocation. Structural barrier from Taiwan. |
| **macOS-first company fleet** | 7 reports | US tech companies (Anthropic, OpenAI, Perplexity, Hopper) run Jamf/Apple fleets by default. |

---

## Closed / Partially Addressed

| Skill | Status | Evidence |
|-------|--------|---------|
| Docker / containerization | ✅ Covered | In CV, homelab usage documented |
| Active Directory / on-prem identity | ✅ Covered | Welgene / Lunfa environments |
| Network fundamentals (switching, VLANs, firewall) | ✅ Covered | Cisco/Fortinet/pfSense in CV |
| IaC / Terraform | ✅ Covered | Documented in CV |
| PowerShell / scripting | ✅ Covered | SCCM automation, Windows env |
| Microsoft Intune / MDM platforms | ✅ Covered | Real experience confirmed -- added to cv.md. Partially mitigates Jamf Pro gap. |

---

## Learning Priorities (Recommended)

Based on gap frequency and role alignment:

1. 🥇 **Okta** — Free developer tenant available; covers identity gap across 5+ US tech roles
2. 🥇 **macOS + Jamf Pro** — Jamf has a 90-day trial; resolves the most-flagged gap
3. 🥈 **Kubernetes** — k3s/minikube lab is achievable; CKA cert would remove this flag permanently
4. 🥈 **Google Workspace** — Free Workspace trial; transferable from O365 admin skills
5. 🥉 **ISO 27001 Lead Implementer** — Certification course removes hard blocker for compliance-heavy roles

---

*Last updated: 2026-05-01 — generated from pipeline reports 001–085*
