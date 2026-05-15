export interface RedactionResult {
  content: string
  count: number
  types: string[]
}

interface Pattern {
  type: string
  regex: RegExp
  replacement: string | ((match: string) => string)
}

const PATTERNS: Pattern[] = [
  {
    type: 'ssh_private_key',
    regex: /-----BEGIN (?:OPENSSH|RSA|DSA|EC|ED25519) PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH|RSA|DSA|EC|ED25519) PRIVATE KEY-----/g,
    replacement: '[REDACTED_SSH_PRIVATE_KEY]',
  },
  {
    type: 'github_token',
    regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    replacement: '[REDACTED_GITHUB_TOKEN]',
  },
  {
    type: 'api_key',
    regex: /\b(?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*["']?[^"'\s`]{8,}/gi,
    replacement: match => `${match.split(/[:=]/)[0].trim()}=[REDACTED_SECRET]`,
  },
  {
    type: 'credential_label',
    regex: /\b(?:passw(?:ort|örter|oerter)?|kennwort|password|passwd|pwd)\s*[:=]\s*["'`]?[^"'\s`]{8,}["'`]?/gi,
    replacement: match => `${match.match(/^[^:=]+[:=]/)?.[0].trim() ?? 'credential:'} [REDACTED_SECRET]`,
  },
  {
    type: 'credential_cli_arg',
    regex: /--(?:newpassword|password|passwd|token|secret)(?:=|\s+)["']?[^"'\s`]+["']?/gi,
    replacement: match => `${match.match(/^--[a-z-]+/i)?.[0] ?? '--credential'}=[REDACTED_SECRET]`,
  },
  {
    type: 'bearer_token',
    regex: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
    replacement: 'Bearer [REDACTED_TOKEN]',
  },
  {
    type: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: '[REDACTED_JWT]',
  },
  {
    type: 'basic_auth_url',
    regex: /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/g,
    replacement: match => match.replace(/\/\/[^/\s:@]+:[^/\s@]+@/, '//[REDACTED_CREDENTIALS]@'),
  },
  {
    type: 'signed_download_url',
    regex: /\bhttps:\/\/software\.download\.prss\.microsoft\.com\/[^\s<>)`'"]+/gi,
    replacement: match => `${match.split('?')[0]}?[REDACTED_SIGNED_QUERY]`,
  },
  {
    type: 'signed_url_query',
    regex: /([?&](?:t|P[1-4]|sig|signature|expires|X-Amz-Signature|AWSAccessKeyId|se|sp|sv|sr|skoid|sktid|skt|ske|sks|skv)=)[^&\s<>)`'"]+/gi,
    replacement: '$1[REDACTED]',
  },
]

export function redactSecrets(content: string): RedactionResult {
  let output = content
  let count = 0
  const types = new Set<string>()

  for (const pattern of PATTERNS) {
    output = output.replace(pattern.regex, (...args: unknown[]) => {
      count++
      types.add(pattern.type)
      if (typeof pattern.replacement === 'function') {
        return pattern.replacement(String(args[0]))
      }
      return pattern.replacement
    })
  }

  return {
    content: output,
    count,
    types: [...types].sort(),
  }
}
