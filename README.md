# 눈치게임

실시간 멀티플레이어 눈치게임. Node.js + Express + Socket.io

## Railway 배포 방법

### 1. GitHub 저장소 준비

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/<username>/<repo>.git
git push -u origin main
```

### 2. Railway 프로젝트 생성

1. [railway.app](https://railway.app) 접속 후 로그인
2. **New Project** 클릭
3. **Deploy from GitHub repo** 선택
4. 저장소 연결 (처음이면 GitHub 권한 허용 필요)
5. 배포할 저장소 선택 → **Deploy Now**

### 3. 배포 확인

- Railway 대시보드에서 빌드 로그 확인
- 빌드 완료 후 **Settings → Networking → Generate Domain** 클릭
- 생성된 URL로 접속 테스트

### 4. 이후 배포

`main` 브랜치에 push하면 자동으로 재배포됩니다.

```bash
git add .
git commit -m "변경 내용"
git push
```

## 로컬 실행

```bash
npm install
npm run dev   # nodemon (자동 재시작)
npm start     # node 직접 실행
```

http://localhost:3000 접속
