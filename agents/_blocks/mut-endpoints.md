Mutation endpoints (method + JSON body schema):
- POST /api/tickets {workspace_id,title,repo_id?,priority?,assignee?,context?,backend?} (assignee "agent"|"human:<operator>"; context = body text) ; POST /api/tickets/:id/dispatch ; POST /api/tickets/:id/dispatch-plan ; PATCH/DELETE /api/tickets/:id ; POST /api/tickets/:id/note {text}
  · Dropping work: PATCH {status:"dismissed"} — considered and decided against. It closes the ticket and takes it off every board (queue, forum, open counts) while KEEPING it and its reasoning. Note the why first (POST /note), then dismiss. DELETE is only for a ticket that should never have been filed; never DELETE to mean "we're not doing this". The operator's call unless they already said drop it.
- POST /api/jobs {name,goal,workspace_id,cwd,backend?,model?,trigger_type:"manual"|"cron"|"once"|"webhook",cron_expr?,run_at?,timezone?,allowed_tools?,timeout_sec?,notify?} ; POST /api/jobs/:id/run ; PATCH/DELETE /api/jobs/:id ; GET /api/runs?job_id= ; GET /api/runs/:id/story ; POST /api/runs/:id/kill (see JOBS)
- POST /api/runs/:id/continue {seed:"<the message to steer it with>"} — TAKE OVER a headless run. A headless process has no stdin: you cannot slip a message into it. This stops it and reopens the SAME CLI transcript as a LIVE terminal seeded with your message (claude-code keeps full context; other backends restart seeded with the run summary). It returns the new session — it appears on the operator's wall on its own. This is how you steer background work. It KILLS the headless process, so confirm with the operator first, naming the run.
- POST /api/sessions {workspace_id,ticket_id?,role,seed?,agent_name?} ; POST /api/sessions/:id/kill ; POST /api/sessions/:id/resume (revive a killed one)
- POST /api/sessions/:id/wait {until?,timeout_ms?} ; POST /api/runs/:id/wait {until?,timeout_ms?} — pin-wait until
    idle|working|blocked|done|unknown|settled (settled = idle|done|blocked). Default timeout 120s.
- POST /api/agents/:idOrName/name {name} ; POST /api/agents/:idOrName/report {state,state_label?,blocked_reason?,ttl_ms?}
- POST /api/agents/:idOrName/seen ; POST /api/agents/:idOrName/wait {until?,timeout_ms?}
- GET/POST /api/board — the shared feed; @mention an executive in body to wake them (see THE BOARD block)
- POST /api/asks/:id/answer {answer,by} — answer an open ask directly (by:"robert") when it's safely your
    call; otherwise raise it to the operator and let them answer
- POST /api/asks/:id/hold {until:"+2h"|"+2d"|ISO|null,reason?} ; POST /api/reviews/:id/hold {same} ; POST /api/recovery/:id/hold {same}
    — SAFE (reversible: deferring decides nothing, and `until:null` lifts it). When the operator says "later" /
    "mañana" / "después" / "not now" about a pending decision, HOLD IT WITH A DATE instead of leaving it live or
    inventing an answer: a held item leaves the live "needs you" list and comes back on its date with the same card.
    GET /api/asks?status=open&bucket=live|dated|aged|all (default live) shows which; only an answer closes one.
- POST /api/messages {to,text,from} — `mc tell`: redirect a running or parked worker. to = ticket key
    (durable — survives park/resume/retry); delivery piggybacks on the worker's own next step/note
    checkpoint, there is no push into a live process
- POST /api/reviews/:id/{approve,changes,merge} ; POST /api/reviews/:id/dispatch-review (kick off the AI reviewer on a pending PR)
- POST /api/skills/:id/{approve,reject}
- POST /api/workspaces/:id/ideas {title,pitch,kind:"expansion"|"new"|"improvement"|"ux-ui"|"qa"|"visibility",source:"manual",repo_id?} — file an idea-pool card
- POST /api/ideas/:id/promote {external?} ; POST /api/ideas/:id/kill ; POST /api/ideas/kill {ids:[]}
- POST /api/workspaces/:id/jots {title,body?} — park a row on that client's pad ; POST /api/jots/:id/append {text} (any terminal on its own client; adds, never replaces) ; PATCH /api/jots/:id {title?,body?,status?} ; DELETE /api/jots/:id ; POST /api/jots/:id/run {backend?,model?,cwd?} (opens a terminal seeded from the row). Prefer the `mc pad` CLI — it resolves id prefixes and appends without clobbering.
- POST /api/workspaces/:id/ideas/generate {feeder:"miner"|"followups"|"intake"} — start headless idea job (admin; returns job_id/run_id)
    feeder "intake" = the chief-of-staff sweep: reads Slack channels, ended meetings, open PR comments,
    blocked delivery and the tracker, and files SPECCED drafts (title + pitch + acceptance criteria) into
    the pool. Runs on its own cron when ideas_config.intake.enabled; this just runs it now.
- POST /api/ideas/promote {ids:[],external?} — promote a BATCH of drafts to tickets in one call
- POST /api/tickets/:id/ideas/generate — follow-up ideas for one ticket (admin; background run)
- POST /api/notes {workspace_id,title,body?} ; PATCH /api/notes/:id {append?,heading?,body?,title?,pinned?} ; DELETE /api/notes/:id
- POST /api/workspaces/:id/learn {fact,label?} — record ONE durable fact into a workspace's learnings memo
- POST /api/lessons {workspace_id,repo_id?,rule,scope?,topic:"build"|"review"|"comms"} — record a RULE that changes what
    agents do next time. Use this whenever the operator corrects you or a build: their correction is the most
    valuable signal this system gets, and a rule filed here is injected into every future build (topic build),
    reviewer (topic review), or into your own standing context (topic comms — how he wants to be talked to).
    One imperative sentence that generalises past this ticket; scope is a path glob or omitted.
    GET /api/lessons?workspace=&state=active lists them; PATCH /api/lessons/:id {state} promotes/archives.
- PATCH /api/workspaces/:id {auto_plan?,auto_build?,auto_review?,skill_distill?,auto_skill?,plan_panel?,review_panel?,ideas_config?} — toggle a workspace's autonomy / idea feeders
    plan_panel: hard tickets (graded difficulty >= {{panel_min_difficulty}}) get THREE scouts — map / prior art / risk — merged into one brief
    review_panel: high-risk changes get THREE reviewers — spec / correctness / blast radius; any one asking for
      changes sends it back, and approval needs every lens to report with quorum approving
    ideas_config.intake {enabled,count,cron,model,sources?} — the daily intake sweep (sources: slack|calendar|prs|ci|tracker|notes)
- POST /api/workspaces/:id/sync (ClickUp/Jira)
- POST /api/nextday {workspaces?:[workspace ids],steering?:{"<workspace id>":"<what the operator wants weighed in>"},date?:"YYYY-MM-DD"} — PLAN TOMORROW (safe).
    Opens ONE planner terminal per project (default: every project with a default_dir set) that reads that
    client's tracker (Jira/ClickUp), the last terminals worked there, the PRs shipped and in flight, and the memos, then files
    the next workday's cards on the Desk (`mc jot new --date`). Each card = title + Description/Goal/Where to look/Done when/QA,
    and the operator presses ▶ on it in the morning. When they say "plan tomorrow", call this; put anything they
    says about priorities into `steering` under that workspace's id. Re-running for the same date replaces the unrun planner cards.
    GET /api/workspaces/:id/jots?date=YYYY-MM-DD lists a day's cards.
- POST /api/workspaces/:id/repos {name,path,git_remote?,default_branch?,delivery?,done_criteria?,gate_cmds?,risk_paths?,human_gate?,post_merge_cmd?} — attach a repo
    delivery:"commit"|"pr" (pr = build on mc/<key>, Merge opens GitHub PR)
    done_criteria: markdown checklist (Definition of Done) injected into every build/review agent for that repo
    gate_cmds: [{name,cmd}] evidence gates run in the build worktree BEFORE review — this repo's own
      toolchain, whatever it is (e.g. [{"name":"test","cmd":"go test ./..."}]). A red gate sends the
      ticket back to the builder with the output; it never reaches a reviewer.
      GET /api/repos/:id/gates/suggest reads the repo's build files and proposes the list — use it
      before guessing commands for a stack you haven't looked at.
    human_gate: "always"|"med"|"high"|"never" — when an AI approve still needs the operator.
      Risk is computed from the paths a build touched: high = migrations/auth/secrets/deploy/money or
      a very large diff, med = dependency + config files, low = ordinary source. "high" means the AI
      ships low and med on its own. A repo with no gates, or a red gate, always waits for a human
      unless human_gate is "never".
    risk_paths: {high?:[glob],med?:[glob],low?:[glob],use_defaults?:bool} — per-repo overrides
    post_merge_cmd: shell run in repo root AFTER the PR merges to main (repo pulls default branch first); e.g. "npm run build"
- PATCH /api/repos/:id {delivery?,done_criteria?,gate_cmds?,risk_paths?,human_gate?,post_merge_cmd?,ideas_enabled?,default_branch?,git_remote?,name?,path?} — edit repo ship/done/idea-pool config
- DELETE /api/repos/:id
- POST /api/workspaces {slug,name,kind,config_dir,...} / PATCH /api/workspaces/:id — new/edit client workspace

When the operator wants to set "done rules" / validation / human gate for a repo: GET /api/workspaces, find the repo id, GET /api/repos/:id/gates/suggest, then PROPOSE PATCH /api/repos/:id with done_criteria + gate_cmds + human_gate + delivery. You can also toggle workspace autonomy with PATCH /api/workspaces/:id {auto_review?,auto_build?,auto_plan?}.
Screenshots: operators attach validation images on the ticket (web gallery or Telegram photo + KEY caption, e.g. "API-4 before"). If they say "attach next to API-4", photos pin to that ticket. GET /api/tickets/:id/attachments lists them; they inject into build/review agents.

