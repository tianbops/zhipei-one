/**
 * 智配One · CSP 内联脚本哈希表（P1-7b，由 scripts/csp-hashes.mjs 生成，勿手改）
 * ------------------------------------------------------------------
 * 生成方式：node scripts/csp-hashes.mjs（改任何 HTML 内联脚本后必须重跑；
 * 漂移由 tests/csp-hashes.test.mjs 常驻守卫）。
 * 覆盖：20 个文件 / 17 段可执行内联脚本。
 * _headers 对 Pages Functions 响应无效 → API 侧（_json.js）import 本表组装 CSP。
 */
export const INLINE_SCRIPT_HASHES = [
  "'sha256-6cZbWMQszjI/NJGFAo7bPl2caT4X97CIk4zJ+t3zZiM='",
  "'sha256-BC43Ouv/SqBcuaDzc3Ne1sTTSaUOD43viNxt6Ouuqv4='",
  "'sha256-EQJmSLoiJL+PQWC4gR5vK1m00IAIkOncgH8MBRcIFI8='",
  "'sha256-FtNCWvRQ8Fk17rFw1hKRlJwhHLDsg23OtAvJiOm2l7A='",
  "'sha256-Jbs9QYmHmBQ8pd9ra3wOoZWi3L60pBLYa9VnhLpLoXE='",
  "'sha256-Olpv4WZyS2ww4ZTxshC1vGXZYa6gG40pXYAUgL+pvOM='",
  "'sha256-Ugr/ROWqz2c38q1IjBPexc6mwtLx8Ps2WXYPFdznT0U='",
  "'sha256-XA08JObdZbZVLasslDJ8CblQME6wINeX7rW15EbsqZw='",
  "'sha256-cf75Iui0OlJqDOCnnPHxROdfuSannIL1ZAs75ruJkis='",
  "'sha256-dOlUULBTWGYBuLtA7V/UEs3sENOdOPTC8j+OsFRUNjw='",
  "'sha256-eMT6TQXzCqozsul4L3cq/gnK8jCzbH4qlVqfrCgbfEk='",
  "'sha256-fmSxi6o0X0L18UHDMnuUmLsD6zBhC+okAzUDoP1axbc='",
  "'sha256-k+Sfp/w/V937mjbCK6g0p+ekciQu/+tZ7slaOd+C9K8='",
  "'sha256-oluUtCvSV5ngm8HE9k14PbrvQTfQ+198OH4ONcl5B+I='",
  "'sha256-vg4zcO/PWYJRpe2qI8rwNf3wpqBQ/IJxB1fyaLxnMqI='",
  "'sha256-wD7gF6kH1PuUKAZzbay5cr1F8/e/r0R2Uv6O1xlYfKY='",
  "'sha256-zbuCwJsCrV/haN2wi+T5550L0MaACsf4FBjSJFIVoyY='",
];

/** 把哈希表注入基础 CSP 的 script-src（'unsafe-inline' 保留作旧浏览器回退） */
export const cspWithInlineHashes = (base) =>
  base.replace(
    "script-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'" +
      (INLINE_SCRIPT_HASHES.length ? " " + INLINE_SCRIPT_HASHES.join(" ") : "")
  );
