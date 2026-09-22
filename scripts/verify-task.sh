#!/usr/bin/env bash
# verify-task.sh — 커밋/작업 완료 전 자동 검증 스크립트
#
# 이 스크립트는 텍스트 지침(AGENTS.md)과 달리 실제로 실행되어 위반 시 진행을 막습니다.
# 아래 각 단계는 프로젝트 스택에 맞게 직접 채워야 작동합니다(현재는 스캐폴드 상태).
#
# git pre-commit hook으로 연동하는 방법:
#   cp scripts/verify-task.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
# (Husky 등 별도 hook 관리 도구를 쓴다면 해당 도구 설정에서 이 스크립트를 호출하세요.)

set -e

echo "🔍 [Harness Verification] Starting automated checks..."

# 1. 파일 크기 제약 검사 — AGENTS.md 2장/docs/architecture.md의 크기 제약과 맞출 것
echo "📏 [1/4] Checking file line limits..."
# 예시 (TypeScript 기준, 350줄 제한):
# OVERSIZED_FILES=$(find src -type f \( -name "*.ts" -o -name "*.tsx" \) -exec wc -l {} + | awk '$1 > 350 {print $2}')
# if [ -n "$OVERSIZED_FILES" ]; then
#     echo "❌ [FAIL] 다음 파일이 크기 제한을 초과했습니다:"
#     echo "$OVERSIZED_FILES"
#     exit 1
# fi
echo "⚠️  [SKIP] 실제 파일 확장자/제한 줄 수로 위 로직을 채워 활성화하세요."

# 2. 레이어 격리 검사 — AGENTS.md 4장의 절대 규칙과 맞출 것
echo "🛡️ [2/4] Checking layer isolation..."
# 예시 (프론트엔드에서 DB 직접 접근 금지):
# FORBIDDEN_IMPORTS=$(grep -rn "{금지된 import 패턴}" {검사 대상 경로} || true)
# if [ -n "$FORBIDDEN_IMPORTS" ]; then
#     echo "❌ [FAIL] 금지된 레이어 접근이 발견되었습니다:"
#     echo "$FORBIDDEN_IMPORTS"
#     exit 1
# fi
echo "⚠️  [SKIP] 실제 금지 패턴/경로로 위 로직을 채워 활성화하세요."

# 3. 린트 & 타입 체크 — AGENTS.md 3장의 실제 명령어로 교체
echo "🧹 [3/4] Running lint & type check..."
# {린트 명령어} || { echo "❌ [FAIL] 린트 오류가 있습니다."; exit 1; }
# {타입체크 명령어} || { echo "❌ [FAIL] 타입 오류가 있습니다."; exit 1; }
echo "⚠️  [SKIP] AGENTS.md 3장의 실제 명령어로 교체하세요."

# 4. 테스트 실행 — AGENTS.md 3장의 실제 명령어로 교체
echo "🧪 [4/4] Running test suite..."
# {테스트 명령어} || { echo "❌ [FAIL] 테스트가 실패했습니다."; exit 1; }
echo "⚠️  [SKIP] AGENTS.md 3장의 실제 명령어로 교체하세요."

echo "✅ [DONE] 스캐폴드 실행 완료. 위 [SKIP] 항목을 실제 명령어로 채우기 전까지는 아무것도 검증하지 않습니다."
exit 0
