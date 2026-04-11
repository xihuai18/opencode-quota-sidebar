import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  isSupportedQuotaProviderID,
  isSupportedQuotaSnapshot,
  isSupportedQuotaTitleLabel,
} from '../supported_quota.js'

describe('supported quota helpers', () => {
  it('accepts built-in provider ids and known prefixes', () => {
    assert.equal(isSupportedQuotaProviderID('openai'), true)
    assert.equal(isSupportedQuotaProviderID('github-copilot-enterprise'), true)
    assert.equal(isSupportedQuotaProviderID('rightcode-openai'), true)
    assert.equal(isSupportedQuotaProviderID('legacy-provider'), false)
  })

  it('prefers adapterID when deciding snapshot support', () => {
    assert.equal(
      isSupportedQuotaSnapshot({
        providerID: 'legacy-provider',
        adapterID: 'openai',
      }),
      true,
    )
    assert.equal(
      isSupportedQuotaSnapshot({
        providerID: 'openai',
        adapterID: 'legacy-provider',
      }),
      false,
    )
  })

  it('accepts compact title labels for supported providers only', () => {
    assert.equal(isSupportedQuotaTitleLabel('OAI'), true)
    assert.equal(isSupportedQuotaTitleLabel('RC-openai'), true)
    assert.equal(isSupportedQuotaTitleLabel('LEGACYAI'), false)
  })
})
