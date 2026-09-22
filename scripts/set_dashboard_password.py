# -*- coding: utf-8 -*-
"""
대시보드(GitHub Pages 공개 페이지)의 접근 비밀번호를 설정/변경한다.

평문 비밀번호는 어디에도 저장되지 않고, SHA-256 해시만 data/site_password.json에
저장되어 그대로 dashboard/index.html에 구워진다(클라이언트 측 검증이라 완벽한 보안은
아니지만, 우연한 접근을 막는 수준의 "간단한 비밀번호 게이트" 용도).

사용법:
  python scripts/set_dashboard_password.py          # 프롬프트로 새 비밀번호 입력
  python scripts/set_dashboard_password.py "새비번"   # 인자로 바로 지정
"""
import sys
import json
import hashlib
import getpass
from pathlib import Path

ROOT = Path(__file__).parent.parent


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    pw = sys.argv[1] if len(sys.argv) > 1 else getpass.getpass("새 대시보드 비밀번호: ")
    if not pw:
        print("비밀번호가 비어 있습니다. 취소합니다.")
        return
    h = hashlib.sha256(pw.encode("utf-8")).hexdigest()
    (ROOT / "data" / "site_password.json").write_text(
        json.dumps({"sha256": h}, indent=2) + "\n", encoding="utf-8"
    )
    print("저장 완료: data/site_password.json (평문은 저장되지 않음)")
    print("적용하려면 python scripts/build_dashboard.py 를 다시 실행하세요.")


if __name__ == "__main__":
    main()
