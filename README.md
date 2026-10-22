# Project Reviewer

A small web tool that reviews student GitHub projects the way an experienced professor would: structure, security, code quality, testing, and plagiarism (including comparing two repositories to see who copied whom). Reviews are written by Claude, following the instructions in the `skill/` folder.

## How it works

1. You paste a public GitHub repository URL (and optionally a second repo to compare, and the course starter code).
2. The server downloads the repo through the GitHub API as a zip at an exact commit. **No student code is ever executed.**
3. If you gave a second repo, it runs a MOSS-style similarity check (token normalization + winnowing, so renamed variables and reformatting don't hide copying), finds shared distinctive lines, and pulls the commit history of the most similar files.
4. Everything is sent to Claude with the professor instructions from `skill/`, and the review streams back into the page.

Recent reviews are saved in your browser, and you can download each one as Markdown or print it to PDF.

## Deploy to Vercel

You need: a GitHub account, a Vercel account (free, sign in with GitHub), and an Anthropic API key.

1. **Put the code on GitHub.** Create a new repository (private is fine), then upload this folder's contents, or from a terminal:
   ```bash
   cd uni-reviewer-web
   git init && git add . && git commit -m "Project reviewer"
   git branch -M main
   git remote add origin https://github.com/<you>/project-reviewer.git
   git push -u origin main
   ```
2. **Import it in Vercel.** Go to vercel.com → **Add New… → Project** → pick the repository → **Import**. Leave Framework Preset as **Other** and the build settings empty.
3. **Add environment variables** (in the import screen, or later under Settings → Environment Variables):

   | Name | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | your key from console.anthropic.com |
   | `APP_PASSWORD` | a long password only you know |
   | `GITHUB_TOKEN` | optional, see below |
   | `MODEL` | optional default: `claude-opus-5-5` or `claude-sonnet-5-5` |

4. Click **Deploy**. When it finishes, open the URL, enter your password and a repo link.

If you change environment variables later, redeploy (Deployments → ⋯ → Redeploy) so they take effect.

### Optional: GitHub token

Without a token, GitHub allows 60 API requests per hour from the server, which is about 10 reviews per hour (more with comparisons). To raise this to 5,000/hour, create a fine-grained token at github.com → Settings → Developer settings → Personal access tokens, with **Public repositories (read-only)** access, and add it as `GITHUB_TOKEN`. If you give the token access to private repositories, the tool can review those too.

## Using it

- **Course level** changes what's expected: a first-year project isn't penalized for missing CI or tests.
- **Compare with repository** runs the plagiarism comparison. Add the **course starter code** repo too, otherwise every project built on the same template will look similar.
- **Rubric** switches on rubric scoring alongside the default score.
- **Opus** gives the most thorough review; **Sonnet** is faster and cheaper. If a very large repo stops before the review finishes, use Sonnet.

Each review costs Anthropic API credits based on the repo size (the code is sent to Claude). You can see token usage at the top of each finished review and in console.anthropic.com.

## Limits to know

- Only public repos (or private ones your `GITHUB_TOKEN` can read).
- Very large repos are sampled: the most important files first (README, configs, source). Skipped files are listed for the reviewer, and the score is marked provisional when important code is missing.
- Security scanners (Semgrep, gitleaks) and tests are not run; the security review is done by reading the code. The report lists this under Limitations.
- Git dates can be faked by students; the report says so and also uses GitHub's own creation and push times.
- Similarity is evidence, not proof. The integrity section never accuses; you decide.
- Vercel allows the function up to 300 seconds. If reviews get cut off at around 60 seconds, open the project's Settings → Functions and make sure Fluid Compute is enabled.

## Changing the reviewer's behaviour

Edit the files in `skill/` (persona and rules in `SKILL.md`, scoring and plagiarism method in `audit-method.md`, report format in `report-contract.md`), push to GitHub, and Vercel redeploys automatically.

## Project structure

```
api/review.js        serverless function: validation, password, streaming
lib/github.js        downloads repos via the GitHub API (never executes code)
lib/zip.js           zip reader (no dependencies)
lib/similarity.js    MOSS-style similarity + shared distinctive lines
lib/prompt.js        builds Claude's instructions and the repository data
lib/anthropic.js     streams from the Claude API
public/              the web page (index.html, app.js, markdown.js, styles.css)
skill/               the reviewer instructions
```

The app has no npm dependencies.
