# 네이버 주식 섹터 Treemap API 문서

## 개요

이 API는 한국과 미국 주식 시장의 섹터 데이터를 Squarified Treemap 형식으로 제공합니다. 네이버 주식 API(`m.stock.naver.com`)의 데이터를 래핑하여 모바일 앱에 최적화된 시각화 좌표를 제공합니다.

- **기반**: 네이버 주식 모바일 API
- **레이아웃 알고리즘**: Squarified Treemap
- **색상 체계**: 등락률 기반 그래디언트
- **캐시**: 5분 (시장별)

---

## 엔드포인트

### 1. 전체 섹터 Treemap 조회

모든 섹터를 Treemap으로 시각화하기 위한 좌표와 기본 통계를 반환합니다.

```http
GET /api/v2/stock/sectors/treemap?market=US
```

#### 요청 파라미터

| 파라미터 | 타입 | 기본값 | 설명 |
|----------|------|-------|------|
| `market` | string | `US` | 시장 (`US` 또는 `KR`) |

#### 응답 (200 OK)

```json
{
  "timestamp": "2026-03-03T14:30:00Z",
  "market": "US",
  "totalSectorCount": 141,
  "totalRisingCount": 3550,
  "totalFallingCount": 2928,
  "averageChangeRate": 0.45,
  "trafficColor": "#FFC107",
  "sectors": [
    {
      "sectorCode": "57101010",
      "name": "반도체",
      "marketCap": 10107060322728,
      "changeRate": 0.96,
      "color": "#35764E",
      "risingCount": 50,
      "fallingCount": 32,
      "rect": {
        "x": 0.0,
        "y": 0.0,
        "w": 0.45,
        "h": 0.6
      },
      "topStocks": [
        {
          "symbol": "NVDA",
          "name": "엔비디아",
          "nameEng": "NVIDIA Corp",
          "price": 182.48,
          "changeRate": 2.99,
          "changePrice": 5.29,
          "marketCap": 4434264000,
          "color": "#2F9E4F"
        }
      ]
    }
  ]
}
```

#### 응답 필드 설명

**Root 레벨**

| 필드 | 타입 | 설명 |
|------|------|------|
| `timestamp` | ISO8601 | 데이터 조회 시간 (UTC) |
| `market` | string | 시장 (`US` 또는 `KR`) |
| `totalSectorCount` | number | 전체 섹터 개수 |
| `totalRisingCount` | number | 상승 종목 총 개수 |
| `totalFallingCount` | number | 하락 종목 총 개수 |
| `averageChangeRate` | number | 전체 평균 등락률 (%) |
| `trafficColor` | string | 시장 색상 (상승/중립/하락) |
| `sectors` | array | 섹터 배열 |

**Sector 객체**

| 필드 | 타입 | 설명 |
|------|------|------|
| `sectorCode` | string | 섹터 코드 (네이버 기준) |
| `name` | string | 섹터명 |
| `marketCap` | number | 시가총액 (원) |
| `changeRate` | number | 등락률 (%) |
| `color` | string | 섹터 색상 코드 (HEX) |
| `risingCount` | number | 상승 종목 수 |
| `fallingCount` | number | 하락 종목 수 |
| `rect` | object | Treemap 좌표 |
| `topStocks` | array | 상위 3개 대표 종목 |

**Rect 객체**

| 필드 | 타입 | 범위 | 설명 |
|------|------|------|------|
| `x` | number | 0.0~1.0 | 좌측 상단 X 좌표 (정규화) |
| `y` | number | 0.0~1.0 | 좌측 상단 Y 좌표 (정규화) |
| `w` | number | 0.0~1.0 | 너비 (정규화) |
| `h` | number | 0.0~1.0 | 높이 (정규화) |

**Stock 객체**

| 필드 | 타입 | 설명 |
|------|------|------|
| `symbol` | string | 종목 심볼 (NVDA, TSLA 등) |
| `name` | string | 한글 종목명 |
| `nameEng` | string | 영문 종목명 |
| `price` | number | 현재가 |
| `changeRate` | number | 등락률 (%) |
| `changePrice` | number | 등락가 |
| `marketCap` | number | 시가총액 |
| `color` | string | 종목 색상 코드 (HEX) |

---

### 2. 섹터 상세 종목 Treemap 조회

특정 섹터 내 모든 종목을 Treemap으로 시각화합니다.

```http
GET /api/v2/stock/sectors/{sectorCode}/treemap?market=US
```

#### 경로 파라미터

| 파라미터 | 타입 | 설명 |
|----------|------|------|
| `sectorCode` | string | 섹터 코드 (예: `57101010`) |

#### 쿼리 파라미터

| 파라미터 | 타입 | 기본값 | 설명 |
|----------|------|-------|------|
| `market` | string | `US` | 시장 (`US` 또는 `KR`) |

#### 응답 (200 OK)

```json
{
  "sectorCode": "57101010",
  "name": "반도체",
  "market": "US",
  "marketCap": 10107060322728,
  "changeRate": 0.96,
  "color": "#35764E",
  "totalStockCount": 82,
  "stocks": [
    {
      "symbol": "NVDA",
      "name": "엔비디아",
      "nameEng": "NVIDIA Corp",
      "price": 182.48,
      "changeRate": 2.99,
      "changePrice": 5.29,
      "marketCap": 4434264000,
      "color": "#2F9E4F",
      "rect": {
        "x": 0.0,
        "y": 0.0,
        "w": 0.3,
        "h": 0.4
      }
    }
  ]
}
```

#### 응답 필드 설명

| 필드 | 타입 | 설명 |
|------|------|------|
| `sectorCode` | string | 섹터 코드 |
| `name` | string | 섹터명 |
| `market` | string | 시장 (`US` 또는 `KR`) |
| `marketCap` | number | 섹터 시가총액 (원) |
| `changeRate` | number | 섹터 등락률 (%) |
| `color` | string | 섹터 색상 코드 (HEX) |
| `totalStockCount` | number | 종목 총 개수 |
| `stocks` | array | 종목 배열 (Stock 객체) |

**Stock 객체** (Rect 좌표 포함)

| 필드 | 타입 | 설명 |
|------|------|------|
| `symbol` | string | 종목 심볼 |
| `name` | string | 한글 종목명 |
| `nameEng` | string | 영문 종목명 |
| `price` | number | 현재가 |
| `changeRate` | number | 등락률 (%) |
| `changePrice` | number | 등락가 |
| `marketCap` | number | 시가총액 |
| `color` | string | 종목 색상 코드 (HEX) |
| `rect` | object | **Treemap 좌표 (필수)** |

---

## 색상 코드

색상은 등락률을 기반으로 자동 할당됩니다.

### 색상 매핑 규칙

| 등락률 범위 | 색상 | 의미 |
|-----------|------|------|
| ≥ 3.0% | `#2F9E4F` | 강한 상승 |
| 1.5% ~ 3.0% | `#45A65C` | 상승 |
| 0.5% ~ 1.5% | `#6BB977` | 약한 상승 |
| -0.5% ~ 0.5% | `#FFAA00` | 보합 (황색) |
| -1.5% ~ -0.5% | `#F98B3D` | 약한 하락 |
| -3.0% ~ -1.5% | `#E05638` | 하락 |
| ≤ -3.0% | `#BE1A0F` | 강한 하락 |

### 시장 색상 (Traffic Color)

Root 레벨의 `trafficColor`는 시장 전체의 상승/보합/하락 비율을 나타냅니다.

| 상황 | 색상 |
|------|------|
| 상승 우세 | `#2F9E4F` (녹색) |
| 보합 우세 | `#FFAA00` (황색) |
| 하락 우세 | `#BE1A0F` (빨강) |

---

## Treemap 좌표 시스템

### 좌표 정규화

모든 좌표는 **0.0 ~ 1.0** 범위로 정규화됩니다.

- **X축**: 왼쪽 상단이 0.0, 오른쪽 상단이 1.0
- **Y축**: 왼쪽 상단이 0.0, 왼쪽 하단이 1.0

### Android 구현 예시

```kotlin
// Treemap 데이터 받기
val response = restTemplate.getForObject(
    "http://api/v2/stock/sectors/treemap?market=US",
    SectorTreemapResponseDTO::class.java
)

// 화면 크기에 맞게 좌표 변환
val screenWidth = 1080  // 픽셀
val screenHeight = 1920  // 픽셀

response.sectors.forEach { sector ->
    val rect = sector.rect
    val pixelX = (rect.x * screenWidth).toInt()
    val pixelY = (rect.y * screenHeight).toInt()
    val pixelW = (rect.w * screenWidth).toInt()
    val pixelH = (rect.h * screenHeight).toInt()

    // Canvas에 그리기
    drawRect(pixelX, pixelY, pixelW, pixelH, color = sector.color)
    drawText(sector.name, pixelX + 10, pixelY + 30)
}
```

### 웹 구현 예시 (Canvas)

```javascript
// Treemap 데이터 받기
const response = await fetch('http://api/v2/stock/sectors/treemap?market=US');
const data = await response.json();

const canvas = document.getElementById('treemapCanvas');
const ctx = canvas.getContext('2d');

data.sectors.forEach(sector => {
  const rect = sector.rect;
  const x = rect.x * canvas.width;
  const y = rect.y * canvas.height;
  const w = rect.w * canvas.width;
  const h = rect.h * canvas.height;

  // 사각형 그리기
  ctx.fillStyle = sector.color;
  ctx.fillRect(x, y, w, h);

  // 텍스트 그리기
  ctx.fillStyle = '#fff';
  ctx.font = '14px sans-serif';
  ctx.fillText(sector.name, x + 5, y + 20);
});
```

---

## 캐싱 정책

### 캐시 설정

| 엔드포인트 | 캐시 시간 | 캐시 키 |
|----------|---------|--------|
| `/sectors/treemap` | 5분 (300초) | `market` 파라미터 (US/KR) |
| `/sectors/{sectorCode}/treemap` | 캐시 미적용 | - |

### 캐시 무효화

섹터 상세 API는 캐시를 적용하지 않습니다. 섹터 수(141 US + 79 KR = 220개) × 2 시장 = 440+ 캐시 키 생성을 피하기 위함입니다.

---

## 호출 예시

### cURL

```bash
# US 시장 전체 섹터
curl -X GET "http://localhost:8080/api/v2/stock/sectors/treemap?market=US" \
  -H "Content-Type: application/json"

# KR 시장 전체 섹터
curl -X GET "http://localhost:8080/api/v2/stock/sectors/treemap?market=KR" \
  -H "Content-Type: application/json"

# US 반도체 섹터 상세
curl -X GET "http://localhost:8080/api/v2/stock/sectors/57101010/treemap?market=US" \
  -H "Content-Type: application/json"
```

### JavaScript (fetch)

```javascript
// US 시장 전체 섹터
const response = await fetch('http://localhost:8080/api/v2/stock/sectors/treemap?market=US');
const data = await response.json();
console.log(data);

// KR 시장 반도체 섹터 상세
const response2 = await fetch(
  'http://localhost:8080/api/v2/stock/sectors/57101010/treemap?market=KR'
);
const data2 = await response2.json();
console.log(data2);
```

### Kotlin (RestTemplate)

```kotlin
val restTemplate = RestTemplate()

// US 시장 전체 섹터
val response = restTemplate.getForObject(
    "http://localhost:8080/api/v2/stock/sectors/treemap?market=US",
    SectorTreemapResponseDTO::class.java
)
println(response)

// KR 시장 반도체 섹터 상세
val response2 = restTemplate.getForObject(
    "http://localhost:8080/api/v2/stock/sectors/57101010/treemap?market=KR",
    SectorDetailTreemapResponseDTO::class.java
)
println(response2)
```

---

## 에러 응답

### 400 Bad Request

페이지 범위를 초과한 요청 (내부 처리됨, 반환 안 함)

```json
{
  "timestamp": "2026-03-03T14:30:00Z",
  "status": 400,
  "error": "Bad Request",
  "message": "Invalid page parameter"
}
```

### 500 Internal Server Error

API 호출 실패 또는 네이버 API 서비스 장애

```json
{
  "timestamp": "2026-03-03T14:30:00Z",
  "status": 500,
  "error": "Internal Server Error",
  "message": "Failed to fetch sector data"
}
```

---

## 데이터 업데이트 주기

- **데이터 소스**: 네이버 주식 API (실시간)
- **캐시 만료**: 5분
- **최대 응답 시간**: ~2초 (첫 요청), ~100ms (캐시 히트)

---

## 마켓별 섹터 개수

| 시장 | 섹터 개수 | 페이지 수 |
|------|---------|---------|
| US | 141개 | 13페이지 |
| KR | 79개 | 8페이지 |

---

## 통합 가이드

### 안드로이드 앱 통합

1. **V2 API 호출**
   ```kotlin
   val sectorData = restTemplate.getForObject(
       "http://api/v2/stock/sectors/treemap?market=US",
       SectorTreemapResponseDTO::class.java
   )
   ```

2. **Treemap 렌더링**
   - 각 섹터의 `rect` 좌표를 사용해 화면에 배치
   - `color` 값을 배경색으로 설정

3. **상세 화면 이동**
   - 섹터 탭 시 `sectorCode`로 상세 API 호출
   ```kotlin
   val detailData = restTemplate.getForObject(
       "http://api/v2/stock/sectors/${sectorCode}/treemap?market=US",
       SectorDetailTreemapResponseDTO::class.java
   )
   ```

### 웹 대시보드 통합

1. **전체 섹터 뷰**
   - Canvas 또는 SVG로 Treemap 렌더링
   - Hover 시 섹터 정보 팝업

2. **상세 뷰**
   - 섹터 클릭 시 종목 Treemap 표시
   - 종목 클릭 시 상세 페이지 이동

---

## 주요 변경사항

### V1 → V2 마이그레이션

| 항목 | V1 (S&P 500) | V2 (네이버 섹터) |
|------|------------|-----------------|
| 데이터 소스 | FMP API | 네이버 주식 API |
| 시장 범위 | US만 | US + KR |
| 섹터 개수 | 11개 (S&P 500) | 141개 (US) + 79개 (KR) |
| 종목 포함 | 상위 5개 | 상위 3개 (목록), 전체 (상세) |
| 캐시 시간 | 1800초 | 300초 |

---

## 문제 해결

### Q: Treemap 좌표가 겹치거나 범위를 벗어남

**A**: 좌표는 항상 0.0~1.0 범위 내입니다. 화면 크기에 맞게 스케일링할 때 정확한 픽셀 계산을 확인하세요.

```kotlin
// 잘못된 예
val pixelX = rect.x  // 0.5 → 0.5 픽셀

// 올바른 예
val pixelX = (rect.x * screenWidth).toInt()  // 0.5 → 540 픽셀 (1080px 기준)
```

### Q: 색상이 예상과 다름

**A**: 색상은 등락률을 기반으로 계산됩니다. `changeRate` 필드를 확인하세요.

### Q: 캐시 때문에 오래된 데이터가 보임

**A**: 전체 섹터는 5분 캐시가 적용됩니다. 섹터 상세는 캐시 미적용이므로 항상 최신 데이터입니다.

---
