<div align="center">

# Research Workbench

### Read. Annotate. Write. All in one local workspace.

Review PDFs, edit LaTeX and manage references side by side.<br>
Your files stay on your computer, in folders you control.

[![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square)](https://www.python.org/downloads/)
[![Local first](https://img.shields.io/badge/Local-first-52796F?style=flat-square)](#your-research-your-files)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/License-PolyForm_Noncommercial-7C6AA6?style=flat-square)](LICENSE)

**[Get started](#get-started)** · **[User guide](docs/USER_GUIDE.md)** · **[HTTP API](API.md)** · **[Contribute](CONTRIBUTING.md)**

</div>

---

## One desk for your research

Move between a paper, its source and its references without leaving the workspace.
Research Workbench runs in your browser with a local Python server. The core
application needs no account, pip install or npm install; browser libraries are bundled.

| Review the paper | Write the source | Keep everything connected |
| :--- | :--- | :--- |
| Highlight passages and add comments | Edit LaTeX beside its compiled PDF | Browse project folders and linked sources |
| Suggest removals and replacements | Jump between source and output | Edit and format BibTeX references |
| Draw and export annotated copies | Insert tables and compile papers or files | Complete citations and flag duplicate keys |
| Preserve the original PDF | Review source changes | Preview Markdown, JSON and JPG/PNG files |

Use the [HTTP API](API.md) to read reviews and apply supported source edits from
scripts or assistants. The [LLM integration guide](llms.txt) documents the available operations.
Optional OpenAlex checks can flag reference metadata discrepancies.

## Get started

**Python 3.10+ and a browser are enough for PDF review and text editing.**

```sh
git clone https://github.com/DriesCardinaels/research-workspace.git
cd research-workspace
python3 research_workbench.py
```

Open **[127.0.0.1:8766](http://127.0.0.1:8766)** if the browser does not open automatically.
Keep the terminal running; press Ctrl+C to stop the server.

1. **Open a project.** Choose a folder from the Research desk.
2. **Start reviewing.** Import or open a PDF and add annotations.
3. **Save your work.** Wait for **Annotations saved**; use **Save PDF** to export an annotated copy.

<details>
<summary><strong>Optional tools and launch settings</strong></summary>

| Workflow | Requirements |
| :--- | :--- |
| LaTeX compilation and source/PDF navigation | Git, `latexmk`, `pdflatex` and `synctex` on PATH |
| OpenAlex reference checks | Internet access; configure integration settings in the app |
| Remote repository synchronization | Git and credentials for the chosen remote |
| Development checks | Python and Node.js; see [test requirements](tests/README.md) |

Choose another port or start without opening the browser:

```sh
python3 research_workbench.py --port 8767 --no-browser
```

</details>

## Your research, your files

**Local folders. Editable annotations. Original PDFs preserved.**

Project metadata and editable annotations live in `.research-workbench/`.
Imported PDF versions and exports live in `versions/`. Linked LaTeX files stay
in their source folder and are edited there. Existing projects migrate their
previous metadata directory automatically when opened, preserving its contents.
Back up the complete project folder and any externally linked source folders.

Annotations save automatically. PDF exports are separate from editable review data.
A suggested removal marks text; it does not redact the original PDF. Source saves
check revisions to avoid silently overwriting external edits.

Local `projects/`, settings and OpenAlex credentials are excluded from this
repository. Opening a project does not publish its files. Optional metadata checks
and remote Git operations use the network.

## Explore the documentation

| For users | For developers |
| :--- | :--- |
| [User guide](docs/USER_GUIDE.md) — workflows, shortcuts and recovery | [Contributing](CONTRIBUTING.md) — setup and contribution conventions |
| [HTTP API](API.md) — requests, responses and source editing | [Architecture](docs/ARCHITECTURE.md) — module ownership and boundaries |
| [LLM integration](llms.txt) — assistant capabilities and constraints | [Extension guides](docs/README.md) — add tools, editors and file types |
| [Licensing](LICENSING.md) — use, adapt and share | [Tests](tests/README.md) — regression and integration checks |

<details>
<summary><strong>Repository map and development checks</strong></summary>

| Path | Purpose |
| :--- | :--- |
| `research_workbench.py` | Application launcher |
| `research_workbench/` | Python application, domain rules, infrastructure and HTTP transport |
| `static/` | Browser interface, editors, feature modules and bundled libraries |
| `extensions/` | Shared file-type catalog |
| Other root Python modules | Compatibility imports for existing scripts and integrations |
| `tests/`, `tools/`, `.github/` | Regression suites, maintenance commands and CI |
| `docs/` | User and developer guides |
| `legacy/`, `work/` | Historical workflows and development experiments |

Run the reproducible checks:

```sh
python3 tools/check.py
```

[Migration status](docs/MIGRATION_STATUS.md) · [Repository automation](.github/AUTOMATION.md) · [Security](SECURITY.md)

</details>

## Make it yours

Inspect, fork and adapt Research Workbench under the
**[PolyForm Noncommercial License 1.0.0](LICENSE)**. Share your adaptations for
permitted purposes, including noncommercial use. Commercial use requires separate
permission unless an explicit license permission applies. Educational institutions
and public research organizations are explicitly permitted regardless of funding.

This is source-available software with noncommercial restrictions, rather than
OSI-defined open-source software. See [LICENSING.md](LICENSING.md) for the full
permissions and contribution terms. Your research documents retain their own
ownership and licensing; bundled components retain their [upstream licenses](static/vendor/README.md).
