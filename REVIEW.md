# Review

- Compare the complete diff with spec #1 and its acceptance criteria; name each AC the PR claims and the test that proves it.
- Important: an edit that re-renders or reorders configuration outside the owned entry, an undo that does not restore the before image, or a receipt that cannot detect a third-party change.
- Important: a path that follows a link, an unbounded read, or an environment override read differently from the spec's table (trim, empty-means-set, `~` expansion).
- Important: a host shape without the verified versions, or a runtime dependency.
- Error messages: a new or changed error names the cause and the next step.
- Check that tests use fixture homes only and stay offline.
- Do not report: formatting, naming preferences, `ponytail:` simplifications that state their ceiling. At most five nits.
