# README structure research

Research date: 2026-11-15. Scope: seven public repositories, read directly through
GitHub's file connector or their first-party raw README. This is a structural comparison, not a ranking: star
counts, popularity order and claims that a structure causes adoption were not
verified. Source links below refer to the default-branch versions observed on
this date and can change later.

## Primary-source observations

| Repository | Observed structure | Application to Research Workbench |
| --- | --- | --- |
| [codecrafters-io/build-your-own-x](https://github.com/codecrafters-io/build-your-own-x/blob/master/README.md) | Banner, short purpose statement, category navigation, grouped tutorial links, contribution instructions, origins and license. | Adopt the immediate purpose statement and scannable navigation. Its long catalog is the product itself; that length is not a reason to put an application's full manual in its landing README. |
| [sindresorhus/awesome](https://github.com/sindresorhus/awesome/blob/main/readme.md) | Branded header and sponsorship material, links to separate contribution/list-creation guides, a Contents section, then categorized links. | Adopt clear routing to separate guides. Its catalog hierarchy suits a resource index, not a PDF/LaTeX editor's onboarding. Do not imitate the large promotional header. |
| [freeCodeCamp/freeCodeCamp](https://github.com/freeCodeCamp/freeCodeCamp/blob/main/README.md) | Banner and badges, purpose and audience, table of contents, curriculum/platform overview, bug and security reporting, contribution links, license and sponsors. Contributor instructions are linked rather than reproduced in full. | Adopt audience-first positioning, distinct user and contributor routes, and links to established policies. Curriculum, charity and community material is specific to that project. |
| [rustdesk/rustdesk](https://github.com/rustdesk/rustdesk/blob/master/README.md) | Header navigation and translations, description and product image, contribution/FAQ/download links, extensive dependency and build instructions, file structure, screenshots. | Adopt an authentic product view and a visible way to start. Its extensive platform-specific build manual is less suitable for an app launched with one Python command. |
| [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases/blob/master/README.md) | Starts with the repository's actual purpose and explicitly distinguishes release/plugin/theme hosting from application source. Routes support and plugin/theme submission to their appropriate destinations, then explains policies and distribution mechanics. | Adopt precise scope and honest limits. This is a distribution/registry repository, not a comparable open-source application README or a reason to imply Research Workbench has Obsidian's licensing model. |
| [AppFlowy-IO/AppFlowy](https://github.com/AppFlowy-IO/AppFlowy/blob/main/README.md) | Product positioning, badges/community links and multiple interface images, user installation, technology stack, development links, roadmap/releases/contributing, rationale, license and acknowledgments. | Adopt the separation between user installation and development setup, and concrete interface evidence. One useful verified screenshot is a better fit here than its long gallery and promotional sections. |
| [microsoft/vscode](https://raw.githubusercontent.com/microsoft/vscode/main/README.md) | A short README with repository/product descriptions, a screenshot and download links, then links for contribution, feedback, related projects, extensions and development, plus conduct and license. | The strongest restrained example of a landing page that routes technical detail elsewhere. Combine this separation with AppFlowy's product-oriented presentation. |

“Adopt” and “better fit” above are editorial judgments for this repository, not
claims made by the source projects. The strongest common pattern is a clear
identity followed by routes to the reader's next task; the examples differ
substantially in length because their repositories serve different purposes.

## Current repository findings

The [current README](../README.md) is 783 lines and 8,678 whitespace-delimited
words at inspection. It begins with an offline Research Workbench description, introduces
API/MCP access, then puts development/migration material before the launch command.
The same document also describes LaTeX editing, BibTeX checks, projects, version
history, UI commands, extension APIs, detailed tests, and legacy preservation.
These observations come from the local file, not from a public repository URL;
no Git remote URL was configured at inspection.

The existing [developer documentation index](README.md),
[contributor guide](../CONTRIBUTING.md), [API reference](../API.md) and
[architecture guide](ARCHITECTURE.md) already provide destinations for technical
detail. A shorter introduction can route readers there without duplicating them.
The current bibliography section also says OpenAlex requests can run automatically
when enabled, so any new opening must qualify the offline claim: the core local
workflow and optional online integrations have different requirements.

## Proposed root README outline

Target approximately 100–160 lines; this is an editorial budget, not a measured
industry standard.

1. **Research Workbench.** Plain text heading, without a logo. One concise description covering local PDF review,
   LaTeX writing and BibTeX management in a browser interface. State Python 3.10+
   for the core app, bundled browser dependencies, and optional online features
   without implying every feature works offline.
2. **Product view, if available.** One real, current screenshot with useful alt
   text. Omit the section until an approved image exists; do not fabricate a
   screenshot or embed an unverified asset.
3. **What it does.** Four or five short capability bullets: PDF annotations and
   exports; linked source/PDF review; bibliography editing and explicit metadata
   checks; local projects and version history; HTTP/MCP access. Mention limits
   where they affect the decision to use the app.
4. **Quick start.** The existing `python3 research_workbench.py` command from the checkout,
   loopback URL, keep-terminal-running instruction, and Ctrl+C to stop. A compact
   requirements table distinguishes Python-only PDF use from LaTeX/Git tools and
   optional network integrations. Do not invent release installers.
5. **First review.** Three short steps: open a project, import/open a PDF, annotate
   and export. Link to the complete user guide after that guide exists.
6. **Data and limits.** State where project data lives, what to back up, that PDF
   exports are separate from editable annotation storage, and the scope of
   external metadata requests. Keep detailed storage schemas in reference docs.
7. **Documentation.** A small task-to-link table: user guide, API/MCP reference,
   contributor entry point, developer index, architecture and tests. Link only
   existing files or files created in the same authorized change.
8. **Development.** A short contributor route and verified baseline validation
   command, with prerequisites/details delegated to the existing guides.
9. **License/credits only when established.** Link the project's verified license
   if one exists. Bundled third-party licenses do not establish the application's
   own license. Include no invented license, status badge or support destination.

## Preservation and change boundary

This research changes only this note. It does not rewrite the root README or move
the manual. If a README rewrite is authorized, preserve the existing user
instructions in a dedicated guide (for example `docs/USER_GUIDE.md`), retain useful
anchors or update inbound links, and relocate developer extension detail to its
existing owning guides. Do not discard requirements, save/version behavior,
recovery instructions, limitations or integration caveats to meet the length
target. Validate every relative link after any authorized move.

## Retrieved source identities

GitHub returned these file blob SHAs for the observed contents. These identify
the fetched file contents; they are not repository commit SHAs.

| Source | File blob SHA |
| --- | --- |
| [build-your-own-x README](https://github.com/codecrafters-io/build-your-own-x/blob/master/README.md) | `bdf16142a9f2050306ef60419100a5e8a55b0829` |
| [awesome readme](https://github.com/sindresorhus/awesome/blob/main/readme.md) | `0acaa99d5f45582ecf70f987213f59ae1855226f` |
| [freeCodeCamp README](https://github.com/freeCodeCamp/freeCodeCamp/blob/main/README.md) | `ece9e49faaf72689d1b3e60ba484c63e36969303` |
| [RustDesk README](https://github.com/rustdesk/rustdesk/blob/master/README.md) | `aa60d4957b8b8c641cb667cced3930a0e062f555` |
| [Obsidian releases README](https://github.com/obsidianmd/obsidian-releases/blob/master/README.md) | `bcc35a1ce9af721daef5efae6ca61cd8b99150b9` |
| [AppFlowy README](https://github.com/AppFlowy-IO/AppFlowy/blob/main/README.md) | `4072edec24f1e38f47c48ec774eca09ce06af354` |
