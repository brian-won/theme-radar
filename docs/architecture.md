# Architecture & System Design Guide

> `AGENTS.md`에서 참조하는 하위 상세 명세서입니다. 레이어 경계, 의존성 방향, 모듈화 원칙을 정의합니다. 아키텍처를 건드리지 않는 작업에서는 읽지 않아도 됩니다.

## 1. 레이어 구조
```text
{예: Client/Frontend Layer → API/Controller Layer → Domain/Business Logic Layer → Data Access Layer}
```

## 2. 필수 레이어 제약
- {예: 클라이언트 코드는 DB ORM을 직접 import할 수 없다. 모든 데이터 통신은 API 레이어를 경유한다.}
- {예: 도메인 모듈 간 상호 참조는 공개 배럴 파일(index.ts)만 허용한다.}

## 3. 파일/모듈 크기 제약
- 단일 파일 최대 {N}줄. 초과 시 즉시 분할(Decompose).
- 반복되는 공통 로직(비동기 헬퍼, 에러 핸들링, 검증 스키마 등)은 `{경로}`에 일원화한다.

## 4. 네트워크 및 에러 처리 원칙
- 외부 API/HTTP 호출은 타임아웃({N}초) 및 재시도(백오프) 로직을 필수로 감싼다.
- 진입점(Edge)에서 입력을 검증된 타입으로 파싱한 뒤에만 내부 레이어로 전달한다.
