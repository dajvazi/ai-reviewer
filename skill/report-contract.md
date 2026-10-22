# Report Contract

Write two files to an output directory outside the inspected repositories:

- `review-report.md`: the human-readable review for the professor (and, optionally, the student).
- `review-report.json`: the same results in structured form, for spreadsheets or grading systems.

Then print the terminal summary.

## 1. review-report.md

Use this structure and these headings, in this order.

```markdown
# Project Review: <owner>/<repository>

**Commit:** <sha> · **Branch:** <branch> · **Reviewed:** <date>
**Course level:** <level> (<given | assumed>)
**Final score:** <x.x> / 10 <(provisional) if applicable>
**Integrity confidence:** <Low | Moderate | High | Very high | Not assessed>

## 1. Project overview
What the project does, the stack, entry points, architecture, data storage,
external integrations, and how it is run. Keep it short.

## 2. Strengths
3–5 genuine strengths with evidence (file references).

## 3. Findings
Grouped by category: Structure, Code Quality, Security, Testing,
Documentation, Git Practices, Dependencies. Within each, order by severity.

### [Severity] Short title
- **Location:** `path/to/file.py:42-48`
- **Status:** Confirmed | Likely | Needs manual verification
- **Problem:** ...
- **Why it matters:** ...
- **Fix:**
  ```<language>
  // before
  ...
  // after
  ...
  ```

## 4. Score breakdown
| Category | Score | Weight | Notes |
|---|---|---|---|
...
Caps applied: <none | which cap and why>
Rubric score: <if a rubric was provided>

## 5. Academic integrity
### Single-repository observations
### Comparison with <other repo> (only if provided)
- Similarity summary (tool used, top matching file pairs with percentages)
- Fingerprints found
- Timeline and direction: likely original / likely copy / undetermined
- Innocent explanations considered
- Confidence level and reasoning
> This section presents evidence only. The decision rests with the professor.

## 6. Viva questions
1. ... (`file:line`)
...5.

## 7. What to fix first
Up to 5 prioritized actions.

## 8. Limitations
Tools unavailable, execution skipped, files sampled, access problems,
anything else affecting confidence.
```

## 2. review-report.json

```json
{
  "repository": "owner/repo",
  "commit": "sha",
  "branch": "main",
  "reviewed_at": "ISO-8601 date",
  "course_level": { "value": "2nd year", "assumed": true },
  "final_score": 6.8,
  "provisional": false,
  "caps_applied": [],
  "category_scores": [
    { "category": "code_quality", "score": 7, "weight": 0.25, "applicable": true }
  ],
  "rubric": null,
  "strengths": [
    { "description": "...", "evidence": "path:line" }
  ],
  "findings": [
    {
      "id": "SEC-001",
      "category": "security",
      "severity": "Critical",
      "status": "Confirmed",
      "title": "SQL injection in login query",
      "location": "app/auth.py:42-45",
      "problem": "...",
      "why_it_matters": "...",
      "fix": "...",
      "fix_code": "..."
    }
  ],
  "integrity": {
    "single_repo_observations": [],
    "comparison": {
      "other_repository": "owner/repo2",
      "tool": "Dolos",
      "top_matches": [
        { "file_a": "...", "file_b": "...", "similarity": 0.87 }
      ],
      "fingerprints": [],
      "direction": "likely_original | likely_copy | undetermined",
      "innocent_explanations": [],
      "confidence": "Low | Moderate | High | Very high",
      "reasoning": "..."
    }
  },
  "viva_questions": [
    { "question": "...", "reference": "path:line" }
  ],
  "fix_first": [],
  "limitations": []
}
```

Use `null` for sections that were not assessed (e.g. `comparison` when only one repository was given). Never fill fields with guesses.

## 3. Terminal summary

After writing both files, print:

```
Project:      owner/repo @ <short sha>
Level:        <level>
Score:        <x.x>/10 <(provisional)>
Findings:     <n> Critical · <n> High · <n> Medium · <n> Low
Integrity:    <confidence> <— vs owner/repo2: likely original/copy/undetermined>
Top fix:      <single most important action>
Reports:      <path>/review-report.md, <path>/review-report.json
```

Then explain in 3–5 sentences why the evidence produced this score: the main strengths, the issues that lowered it most, and any cap or limitation that applied.
