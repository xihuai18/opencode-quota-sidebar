import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createDefaultProviderRegistry } from '../providers/index.js'

describe('provider registry', () => {
  it('prefers RightCode adapter over provider ID when baseURL matches', () => {
    const registry = createDefaultProviderRegistry()
    const adapter = registry.resolve({
      providerID: 'openai',
      providerOptions: { baseURL: 'https://www.right.codes/codex/v1' },
    })
    assert.ok(adapter)
    assert.equal(adapter!.id, 'rightcode')
  })

  it('normalizes copilot variants', () => {
    const registry = createDefaultProviderRegistry()
    assert.equal(
      registry.normalizeProviderID('github-copilot-enterprise'),
      'github-copilot',
    )
    assert.equal(registry.normalizeProviderID('openai'), 'openai')
  })

  it('does not match RightCode adapter for non-right baseURL', () => {
    const registry = createDefaultProviderRegistry()
    const adapter = registry.resolve({
      providerID: 'openai',
      providerOptions: { baseURL: 'https://api.openai.com/v1' },
    })
    assert.ok(adapter)
    assert.equal(adapter!.id, 'openai')
  })
})
