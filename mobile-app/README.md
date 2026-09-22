# 테마 레이더 — 안드로이드 앱 (Capacitor 래핑)

이 폴더는 대시보드(`https://brian-won.github.io/theme-radar/`)를 안드로이드 앱 형태로 감싸는
Capacitor 설정만 담고 있습니다. 실제 네이티브 프로젝트(`android/`)와 빌드된 APK는 언제든
아래 절차로 재생성할 수 있어서 git에는 올리지 않습니다(`.gitignore` 참고).

- 앱은 자체 화면이 없고, 항상 `capacitor.config.json`의 `server.url`(GitHub Pages 주소)을
  웹뷰로 띄웁니다 — 대시보드를 새로 빌드해서 푸시하면 앱 재설치 없이 최신 내용이 보입니다.
- 플레이스토어 미배포, 디버그 APK를 직접 사이드로드하는 용도입니다.

## 재생성 절차 (android/ 폴더 + APK가 사라졌을 때)

필요 도구: Node.js, JDK 21, Android SDK(`platform-tools`, `platforms;android-34`,
`build-tools;34.0.0` 이상 — 처음 설치 시 Capacitor/AGP가 필요하면 자동으로 더 받음).

```bash
cd mobile-app
npm install
npx cap add android
npx cap sync android
cd android
# Windows: gradlew.bat assembleDebug   / macOS·Linux: ./gradlew assembleDebug
./gradlew assembleDebug
```

빌드 결과: `android/app/build/outputs/apk/debug/app-debug.apk`

## 앱 이름/아이콘/패키지 ID 바꾸기

- **앱 이름**: `capacitor.config.json`의 `appName` 수정 → `npx cap sync android` 재실행.
- **패키지 ID**: `capacitor.config.json`의 `appId` 수정 — 기존 `android/`를 지우고
  `npx cap add android`부터 다시 하는 게 안전함(사후 변경은 소급 반영 안 됨).
- **아이콘**: `@capacitor/assets` 패키지로 원본 이미지 1장을 여러 해상도로 자동 생성 가능.

## 폰에 설치(사이드로드)

1. APK 파일을 폰으로 전송(카카오톡 나에게 보내기, USB, 드라이브 등).
2. 안드로이드에서 "출처를 알 수 없는 앱 설치" 허용(파일을 열면 자동으로 안내됨).
3. 파일 관리자에서 APK를 탭해 설치.
