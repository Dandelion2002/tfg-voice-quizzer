// Autor:   María León Pérez
// Resumen: Capa de acceso a AWS desde el cliente React. Implementa AWS Signature V4
//          manualmente usando la Web Crypto API (crypto.subtle) para firmar peticiones
//          HTTP a DynamoDB y S3 sin necesidad del SDK de AWS (que es demasiado pesado
//          para un bundle frontend). Expone: dynamo() para operaciones DynamoDB,
//          s3Upload/s3Delete/s3PresignedUrl para gestión de archivos, y hashPassword()
//          para hashing SHA-256 de contraseñas en el cliente.
//
// Variables de entorno requeridas en .env:
//   VITE_AWS_REGION, VITE_AWS_ACCESS_KEY_ID, VITE_AWS_SECRET_ACCESS_KEY, VITE_AWS_BUCKET_NAME

export const REGION = import.meta.env.VITE_AWS_REGION ?? 'eu-west-1';
const KEY_ID        = import.meta.env.VITE_AWS_ACCESS_KEY_ID  as string;
const SECRET        = import.meta.env.VITE_AWS_SECRET_ACCESS_KEY as string;
export const BUCKET = import.meta.env.VITE_AWS_BUCKET_NAME    as string;

const enc = new TextEncoder();

export async function sha256(data: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', enc.encode(data));
}

async function sha256bytes(data: BufferSource): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', data);
}

export async function hmac(key: ArrayBuffer, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}

export function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(pwd: string): Promise<string> {
  return hex(await sha256(pwd));
}

// ── DynamoDB (AWS Signature V4) ───────────────────────────────────────────────
/**
 * Envía una petición firmada con AWS Signature V4 al endpoint de DynamoDB.
 * El 'target' es el nombre de la operación DynamoDB en formato
 * 'DynamoDB_20120810.<Operacion>' (ej. GetItem, PutItem, Scan, UpdateItem, DeleteItem).
 * La firma se recalcula en cada llamada porque incluye la fecha/hora exacta (amzDate).
 */
export async function dynamo(target: string, body: object): Promise<Response> {
  const payload = JSON.stringify(body);
  const now     = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const date    = amzDate.slice(0, 8);
  const host    = `dynamodb.${REGION}.amazonaws.com`;

  const bodyHash  = hex(await sha256(payload));
  const canonical = `POST\n/\n\ncontent-type:application/x-amz-json-1.0\nhost:${host}\nx-amz-date:${amzDate}\n\ncontent-type;host;x-amz-date\n${bodyHash}`;
  const scope     = `${date}/${REGION}/dynamodb/aws4_request`;
  const toSign    = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await sha256(canonical))}`;

  const kDate    = await hmac(enc.encode(`AWS4${SECRET}`).buffer as ArrayBuffer, date);
  const kRegion  = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, 'dynamodb');
  const kSigning = await hmac(kService, 'aws4_request');
  const sig      = hex(await hmac(kSigning, toSign));

  return fetch(`https://${host}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.0',
      'X-Amz-Date': amzDate,
      'X-Amz-Target': target,
      Authorization: `AWS4-HMAC-SHA256 Credential=${KEY_ID}/${scope}, SignedHeaders=content-type;host;x-amz-date, Signature=${sig}`,
    },
    body: payload,
  });
}

// ── S3 PutObject (AWS Signature V4) ──────────────────────────────────────────
/**
 * Sube un objeto a S3 directamente desde el navegador (upload directo al bucket).
 * El bucket necesita CORS con AllowedMethods: ["GET","PUT","DELETE","HEAD"] y
 * AllowedOrigins apuntando al dominio de la app.
 * Cada segmento del key se codifica con encodeURIComponent preservando las barras '/'
 * para que nombres con espacios o caracteres especiales funcionen correctamente.
 */
export async function s3Upload(
  key: string,
  body: Uint8Array | string,
  contentType: string
): Promise<Response> {
  const now     = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const date    = amzDate.slice(0, 8);
  const host    = `${BUCKET}.s3.${REGION}.amazonaws.com`;

  const bodyBytes = typeof body === 'string' ? enc.encode(body) : body;
  const bodyHash  = hex(await sha256bytes(bodyBytes));

  // Codifica cada segmento del path preservando las barras
  const encodedKey   = key.split('/').map(p => encodeURIComponent(p)).join('/');
  const canonicalUri = `/${encodedKey}`;

  const canonical = [
    'PUT',
    canonicalUri,
    '',
    `content-type:${contentType}`,
    `host:${host}`,
    `x-amz-content-sha256:${bodyHash}`,
    `x-amz-date:${amzDate}`,
    '',
    'content-type;host;x-amz-content-sha256;x-amz-date',
    bodyHash,
  ].join('\n');

  const scope  = `${date}/${REGION}/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await sha256(canonical))}`;

  const kDate    = await hmac(enc.encode(`AWS4${SECRET}`).buffer as ArrayBuffer, date);
  const kRegion  = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const sig      = hex(await hmac(kSigning, toSign));

  return fetch(`https://${host}${canonicalUri}`, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'X-Amz-Date': amzDate,
      'X-Amz-Content-SHA256': bodyHash,
      Authorization: `AWS4-HMAC-SHA256 Credential=${KEY_ID}/${scope}, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=${sig}`,
    },
    body: bodyBytes,
  });
}

// ── S3 DeleteObject (AWS Signature V4) ────────────────────────────────────────
// CORS del bucket necesita AllowedMethods: ["GET","PUT","DELETE","HEAD"]
export async function s3Delete(key: string): Promise<Response> {
  const now     = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const date    = amzDate.slice(0, 8);
  const host    = `${BUCKET}.s3.${REGION}.amazonaws.com`;

  const bodyHash     = hex(await sha256(''));
  const encodedKey   = key.split('/').map(p => encodeURIComponent(p)).join('/');
  const canonicalUri = `/${encodedKey}`;

  const canonical = [
    'DELETE',
    canonicalUri,
    '',
    `host:${host}`,
    `x-amz-content-sha256:${bodyHash}`,
    `x-amz-date:${amzDate}`,
    '',
    'host;x-amz-content-sha256;x-amz-date',
    bodyHash,
  ].join('\n');

  const scope  = `${date}/${REGION}/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await sha256(canonical))}`;

  const kDate    = await hmac(enc.encode(`AWS4${SECRET}`).buffer as ArrayBuffer, date);
  const kRegion  = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const sig      = hex(await hmac(kSigning, toSign));

  return fetch(`https://${host}${canonicalUri}`, {
    method: 'DELETE',
    headers: {
      'X-Amz-Date': amzDate,
      'X-Amz-Content-SHA256': bodyHash,
      Authorization: `AWS4-HMAC-SHA256 Credential=${KEY_ID}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${sig}`,
    },
  });
}

// ── S3 GetObject presigned URL ────────────────────────────────────────────────
/**
 * Genera una URL prefirmada para que el navegador descargue un objeto de S3 sin
 * exponer las credenciales. Los parámetros de query deben estar en orden alfabético
 * (requisito de AWS Signature V4 para presigned URLs). Se usa UNSIGNED-PAYLOAD porque
 * el cuerpo de una GET es vacío y S3 presigned URLs no permiten firmado del payload.
 */
export async function s3PresignedUrl(key: string, expiresIn = 3600): Promise<string> {
  const now     = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const date    = amzDate.slice(0, 8);
  const host    = `${BUCKET}.s3.${REGION}.amazonaws.com`;

  const encodedKey      = key.split('/').map(p => encodeURIComponent(p)).join('/');
  const canonicalUri    = `/${encodedKey}`;
  const credentialScope = `${KEY_ID}/${date}/${REGION}/s3/aws4_request`;

  // Los parámetros deben estar ordenados alfabéticamente
  const qParams: [string, string][] = [
    ['X-Amz-Algorithm',     'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential',    credentialScope],
    ['X-Amz-Date',          amzDate],
    ['X-Amz-Expires',       String(expiresIn)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalQS = qParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const canonical = [
    'GET',
    canonicalUri,
    canonicalQS,
    `host:${host}`,
    '',
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const scope  = `${date}/${REGION}/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await sha256(canonical))}`;

  const kDate    = await hmac(enc.encode(`AWS4${SECRET}`).buffer as ArrayBuffer, date);
  const kRegion  = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const sig      = hex(await hmac(kSigning, toSign));

  return `https://${host}${canonicalUri}?${canonicalQS}&X-Amz-Signature=${sig}`;
}
