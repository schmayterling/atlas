# atlas-pinned corpus

phase 1: resolves to the atlas repo root at whatever ref the runner
has checked out. the `ref` field on each question is advisory only
— the runner does not yet check out pinned commits.

phase 2: the runner will clone atlas into a cache dir and
`git checkout` the ref specified by each question, so a scoring run
is reproducible across contributors and across time.

the atlas-pinned corpus is small and well-understood (the repo owners
write the questions) so it is a good validation target for the scoring
pipeline itself. real agent-vs-grep measurement needs a second corpus
(a pinned commit of a sizeable external project) before the delta
numbers carry weight — see the phasing section of #84.
