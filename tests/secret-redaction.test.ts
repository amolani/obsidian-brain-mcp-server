import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets } from '../services/secret-redaction.ts'

describe('secret redaction', () => {
  test('redacts common token and password patterns', () => {
    const result = redactSecrets([
      'token=supersecretvalue12345',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
      'https://user:pass@example.org/path',
    ].join('\n'))

    assert.equal(result.count, 3)
    assert.ok(result.types.includes('api_key'))
    assert.ok(!result.content.includes('supersecretvalue12345'))
    assert.ok(!result.content.includes('user:pass'))
  })

  test('redacts German credential labels, CLI password args, and signed download URLs', () => {
    const result = redactSecrets([
      'Passwort: `VHS-Offenbach2026!`',
      'samba-tool user setpassword netzint1 --newpassword=AbtniMusterPasswd123!',
      'https://software.download.prss.microsoft.com/dbazure/Win11_25H2_German_x64.iso?t=download-token&P1=1778913019&P4=signature',
    ].join('\n'))

    assert.ok(result.types.includes('credential_label'))
    assert.ok(result.types.includes('credential_cli_arg'))
    assert.ok(result.types.includes('signed_download_url'))
    assert.ok(!result.content.includes('VHS-Offenbach2026!'))
    assert.ok(!result.content.includes('AbtniMusterPasswd123'))
    assert.ok(!result.content.includes('download-token'))
    assert.ok(!result.content.includes('signature'))
  })
})
