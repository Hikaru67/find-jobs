# Multi-Agent Delivery Pipeline

Pipeline hỗ trợ hai runtime:

- `codex` (mặc định): dùng Codex CLI đã đăng nhập bằng ChatGPT Plus, không dùng API key.
- `api`: dùng OpenAI Agents SDK và `OPENAI_API_KEY`.

```text
PM → BA → TECH_LEAD task plan
              ↓
     task branches/worktrees (parallel)
       ├─ BACKEND + TECH_LEAD review
       └─ FRONTEND + TECH_LEAD review
              ↓ merge từng task vào dev
       TESTER theo task (parallel)
              ↓
       integration TESTER / bug-fix loop
              ↓
release/sprint-* hoặc release/phase-* → master
```

Mỗi stage trả về một output có schema Zod và được lưu vào `artifacts/`. Pipeline
chỉ chuyển sang stage tiếp theo khi stage hiện tại trả về `status: approved`.
Pipeline cũng lưu checkpoint có hash của project trong
`artifacts/pipeline-state.json`. Nếu tiến trình bị ngắt và chạy lại đúng cùng
request, các stage đã `approved` sẽ được khôi phục và chỉ chạy tiếp stage chưa
hoàn tất. Khi pipeline đã hoàn thành hoặc request thay đổi, pipeline sẽ bắt đầu
run mới.

## Chạy bằng ChatGPT Plus/Codex

Đăng nhập một lần bằng tài khoản ChatGPT Plus:

```bash
codex login
```

Chọn **Sign in with ChatGPT** trong trình duyệt. Sau đó chạy:

```bash
npm run typecheck
npm run dev -- "Xây dựng ứng dụng quản lý việc ứng tuyển, có đăng nhập, theo dõi trạng thái và nhắc lịch phỏng vấn"
```

Runtime `codex` sẽ gọi sáu stage tuần tự. PM, BA, Tech Lead và Tester chạy ở
chế độ chỉ đọc; Backend và Frontend được phép sửa file trong workspace.

## Cài đặt API mode

```bash
npm install
cp .env.example .env
```

Để dùng lại Agents SDK/API mode, đặt trong `.env`:

```text
AGENT_RUNTIME=api
OPENAI_API_KEY=your_api_key_here
OPENAI_MODEL=gpt-6-astra
```

## Chạy

```bash
npm run typecheck
npm run dev -- "Xây dựng ứng dụng quản lý việc ứng tuyển"
```

## Dashboard theo dõi agent

Chạy dashboard local:

```bash
npm run dashboard
```

Mở `http://127.0.0.1:3030`. Dashboard hiển thị trạng thái PM → BA → Tech Lead →
Backend → Frontend → Tester, log trực tiếp, thời lượng, artifact, open questions,
files/tests, lịch sử các run và trạng thái final code review của Tech Lead.

Dashboard chỉ bind vào `127.0.0.1` mặc định. Có thể đổi cổng bằng:

```bash
DASHBOARD_PORT=3031 npm run dashboard
```

Sau khi chạy, artifact của từng vai trò nằm trong:

```text
artifacts/pm.json
artifacts/ba.json
artifacts/tech_lead.json
artifacts/tech_lead_task_review.json
artifacts/tech_lead_review.json
artifacts/backend.json
artifacts/frontend.json
artifacts/tester.json
artifacts/task-plan.json
artifacts/tasks/<task-id>/...
```

Nếu một stage trả về `changes_requested` hoặc `blocked`, agent phải điền
`reviewRequests` để chỉ rõ role chịu trách nhiệm review. Orchestrator tự động route
feedback về role đó, chạy lại các stage phụ thuộc và lặp cho tới khi stage approve.
Các role chỉ được route về role đứng trước trong pipeline; một quyết định thật sự
cần con người vẫn phải được thể hiện rõ trong `openQuestions`.

## Local Git delivery flow

Pipeline hiện chỉ thao tác Git local, không tự push lên remote:

1. Tạo hoặc kiểm tra hai branch nền `dev` và `master`.
2. TECH_LEAD xuất task plan gồm `id`, `owner`, `dependsOn`, `phase`, `sprint` và acceptance criteria.
3. Mỗi task tạo branch `task/<task-id>` từ `dev` và một worktree riêng.
4. Các task không có dependency chạy song song; task có dependency chỉ chạy sau khi dependency đã merge vào `dev`.
5. TECH_LEAD review từng task branch trước khi merge vào `dev`.
6. TESTER chạy song song theo từng task trên `dev`; sau đó integration TESTER chạy trên toàn bộ `dev`.
7. Nếu có lỗi, tạo `bug/<task-id>/<n>-<owner>` từ `dev`, giao đúng DEV sửa, review rồi merge lại vào `dev`; TESTER lặp lại đến khi pass.
8. Sau khi test và release review pass, tạo `release/sprint-<id>` hoặc `release/phase-<id>` từ `dev`, rồi merge release branch vào `master`.

Branch task không bị push. Nếu thư mục đã là Git repository có `.git` ghi được,
pipeline dùng trực tiếp repository đó. Với một workspace managed có `.git` chỉ
đọc, pipeline tự dùng thư mục `.delivery-git/` bị ignore để lưu refs local.

Có thể chọn loại release bằng biến môi trường:

```bash
RELEASE_KIND=sprint RELEASE_ID=01 npm run dev -- "Xây dựng hệ thống tìm jobs IT"
```

Artifact `artifacts/git-workflow.json` lưu branch, commit và release cuối cùng.
Artifact `artifacts/task-plan.json` lưu task plan, dependency và branch tương ứng.

Số agent chạy song song có thể giới hạn bằng:

```bash
MAX_PARALLEL_AGENTS=4 npm run dev -- "Xây dựng hệ thống tìm jobs IT"
```

## Lưu ý về quyền

Runtime `codex` dùng quyền đăng nhập và sandbox của Codex CLI. Không đưa
`OPENAI_API_KEY` vào môi trường khi muốn dùng ChatGPT Plus; runner chủ động bỏ
biến này trước khi gọi Codex để tránh vô tình dùng API credits.

## Quyền theo vai trò

- PM và BA: chỉ phân tích, không sửa code.
- Tech Lead: thiết kế và khóa API contract.
- Backend: chỉ sở hữu code backend.
- Frontend: chỉ sở hữu code frontend.
- Tester: kiểm thử và quyết định release, không sửa feature code.
