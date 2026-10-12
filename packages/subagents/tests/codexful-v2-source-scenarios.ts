/** Captured resolver inputs shared by independent reference fixtures and TypeScript verification. */
import type { SpecOverrides } from '../src/codexful-v2-spec.ts'

/** Independent reference inputs selected from pinned Rust configuration branches. */
export const SCENARIOS: readonly { readonly name: string; readonly input: SpecOverrides }[] = [
  {
    'name': 'effective-default-empty-catalog',
    'input': {},
  },
  {
    'name': 'overrides-disabled',
    'input': {
      'exposeSpawnAgentModelOverrides': false,
    },
  },
  {
    'name': 'exposed-spawn-metadata',
    'input': {
      'hideSpawnAgentMetadata': false,
      'models': [
        {
          'model': 'visible-model',
          'description': 'visible description',
          'showInPicker': true,
          'multiAgentVersion': 'v2',
          'defaultReasoningEffort': 'medium',
          'supportedReasoningEfforts': [
            'medium',
          ],
          'serviceTiers': [
            'priority',
          ],
        },
        {
          'model': 'hidden-model',
          'description': 'hidden description',
          'showInPicker': false,
          'multiAgentVersion': 'v2',
          'defaultReasoningEffort': 'medium',
          'supportedReasoningEfforts': [
            'medium',
          ],
          'serviceTiers': [
            'priority',
          ],
        },
        {
          'model': 'legacy-model',
          'description': 'legacy description',
          'showInPicker': true,
          'multiAgentVersion': 'v1',
          'defaultReasoningEffort': 'medium',
          'supportedReasoningEfforts': [
            'medium',
          ],
          'serviceTiers': [
            'priority',
          ],
        },
        {
          'model': 'disabled-model',
          'description': 'disabled description',
          'showInPicker': true,
          'multiAgentVersion': 'disabled',
          'defaultReasoningEffort': 'medium',
          'supportedReasoningEfforts': [
            'medium',
          ],
          'serviceTiers': [
            'priority',
          ],
        },
      ],
    },
  },
  {
    'name': 'agent-type-and-description-overrides',
    'input': {
      'agentTypesConfigured': true,
      'agentTypeDescription': 'role help',
      'hideSpawnAgentMetadata': false,
      'descriptionOverrides': {
        'spawn_agent': 'Catalog spawning guidance.',
        'send_message': '',
        'wait_agent': 'Wait override.',
      },
      'usageHintText': 'Spawn only when useful.',
      'models': [
        {
          'model': 'visible-model',
          'description': 'visible description',
          'showInPicker': true,
          'multiAgentVersion': 'v2',
          'defaultReasoningEffort': 'medium',
          'supportedReasoningEfforts': [
            'medium',
          ],
          'serviceTiers': [
            'priority',
          ],
        },
      ],
      'defaultWaitTimeoutMs': 12345,
      'minWaitTimeoutMs': 2345,
      'maxWaitTimeoutMs': 45678,
    },
  },
  {
    'name': 'namespace-not-supported',
    'input': {
      'supportsNamespace': false,
    },
  },
  {
    'name': 'direct-messaging-and-wait-disabled',
    'input': {
      'disableDirectMessage': true,
      'waitAgentEnabled': false,
    },
  },
  {
    'name': 'catalog-limit-unicode-and-empty-suffixes',
    'input': {
      'models': [
        {
          'model': 'unicode-model',
          'description': 'unicode description',
          'showInPicker': true,
          'multiAgentVersion': 'v2',
          'defaultReasoningEffort': 'é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀',
          'supportedReasoningEfforts': [
            'é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀é😀',
          ],
          'serviceTiers': [
            'priority',
          ],
        },
        {
          'model': 'second-model',
          'description': 'second description',
          'showInPicker': true,
          'multiAgentVersion': 'v2',
          'defaultReasoningEffort': 'medium',
          'supportedReasoningEfforts': [
            'medium',
          ],
          'serviceTiers': [
            'priority',
          ],
        },
        {
          'model': 'third-model',
          'description': 'third description',
          'showInPicker': true,
          'multiAgentVersion': 'v2',
          'defaultReasoningEffort': 'medium',
          'supportedReasoningEfforts': [
            'medium',
          ],
          'serviceTiers': [
            'priority',
          ],
        },
        {
          'model': 'fourth-model',
          'description': 'fourth description',
          'showInPicker': true,
          'multiAgentVersion': 'v2',
          'defaultReasoningEffort': 'medium',
          'supportedReasoningEfforts': [
            'medium',
          ],
          'serviceTiers': [
            'priority',
          ],
        },
        {
          'model': 'fifth-model',
          'description': 'fifth description',
          'showInPicker': true,
          'multiAgentVersion': 'v2',
          'defaultReasoningEffort': 'medium',
          'supportedReasoningEfforts': [
            'medium',
          ],
          'serviceTiers': [
            'priority',
          ],
        },
        {
          'model': 'sixth-model',
          'description': 'sixth description',
          'showInPicker': true,
          'multiAgentVersion': 'v2',
          'defaultReasoningEffort': 'medium',
          'supportedReasoningEfforts': [
            'medium',
          ],
          'serviceTiers': [
            'priority',
          ],
        },
      ],
    },
  },
  {
    'name': 'empty-description-and-hint-are-present',
    'input': {
      'descriptionOverrides': {
        'spawn_agent': '',
      },
      'usageHintText': '',
      'toolNamespace': 'custom',
    },
  },
  {
    'name': 'spawn-helper-control-defaults',
    'input': {
      'agentTypesConfigured': true,
      'hideSpawnAgentMetadata': false,
      'exposeSpawnAgentModelOverrides': false,
    },
  },
  {
    'name': 'catalog-with-no-efforts-or-service-tiers',
    'input': {
      'models': [
        {
          'model': 'plain-model',
          'description': 'plain description',
          'showInPicker': true,
          'multiAgentVersion': null,
          'defaultReasoningEffort': 'medium',
          'supportedReasoningEfforts': [],
          'serviceTiers': [],
        },
      ],
    },
  },
]
