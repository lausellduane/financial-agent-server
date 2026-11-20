<!-- DRAFT for lausellduane/financial-agent-server: prompts/job-prompt.md.
     The local-builder workflow fills this in and passes it to Aider with --message-file.
     Allowed placeholders, and only these:
       {{CHANGE_PATH}}           openspec/changes/<id>, an id matching ^[a-z0-9-]+$ that exists on master
       {{TASK_NUMBERS}}          e.g. 1.1, 1.2, matching ^[0-9.,]+$ (default: all unchecked tasks)
       {{FILES}}                 taken from the "Files:" lines of those tasks in tasks.md on master
       {{SCENARIOS}}             "#### Scenario:" headings for those tasks, from the change's spec on master
       {{ATTEMPT}}               1 or 2, set by the workflow
       {{TEST_FAILURE_EXCERPT}}  attempt 2 only: the last ~30 lines of `npm test` output from attempt 1; otherwise "none"
     NEVER put issue titles, issue bodies, or comments into this template. -->
You are working in this repository on the approved change at `{{CHANGE_PATH}}`.

Do tasks {{TASK_NUMBERS}} from `{{CHANGE_PATH}}/tasks.md`, in order. Follow `conventions/CONVENTIONS.md` exactly.

Files you may edit (and no others):
{{FILES}}

When you're done, these scenarios must hold:
{{SCENARIOS}}

This is attempt {{ATTEMPT}} of 2.
Test failures from the previous attempt (if any):
```
{{TEST_FAILURE_EXCERPT}}
```

If anything is unclear or a task can't be done within the files listed, write `BLOCKED.md` as described in the conventions and make no other changes.
