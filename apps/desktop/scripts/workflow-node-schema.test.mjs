import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  workflowNodeSchemas,
  constrainSchema,
} from './workflow-node-schema.mjs';

test('Agent and CodeAct use the exact editor fields and requiredness', () => {
  const schemas = workflowNodeSchemas();
  for (const kind of ['agent', 'codeact_agent']) {
    const schema = schemas[kind];
    assert.equal(Object.hasOwn(schema.properties, 'label'), false);
    assert.deepEqual(schema.required, [
      'name',
      'modelProfileId',
      'description',
      'instruction',
    ]);
    assert.equal(schema.additionalProperties, false);
    assert.equal(
      schema.properties.state.properties.access.additionalProperties,
      false,
    );
  }
  assert.ok(schemas.agent.properties.toolCompensations);
  assert.equal(
    Object.hasOwn(schemas.codeact_agent.properties, 'toolCompensations'),
    false,
  );
  assert.deepEqual(Object.keys(schemas.start.properties), ['label']);
  assert.deepEqual(schemas.switch.required, ['cases', 'defaultCase']);
  assert.equal(
    Object.hasOwn(schemas.human_review.properties, 'editableKey'),
    false,
  );
});
test('new fields, nested requiredness, arrays and intersections are derived from TS', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-schema-'));
  try {
    const path = join(root, 'workflow.d.ts');
    writeFileSync(
      path,
      `type State = {state?: {readers: string[]}};
      type Data = State & {name: string; newlyAdded: boolean; optional?: number};
      type WorkflowNode = {type: 'agent'; data: Data} | {type: 'group'; data: {label?: string}};`,
    );
    const schema = workflowNodeSchemas(pathToFileURL(path)).agent;
    assert.deepEqual(schema.required, ['name', 'newlyAdded']);
    assert.deepEqual(schema.properties.newlyAdded, { type: 'boolean' });
    assert.deepEqual(schema.properties.state.required, ['readers']);
    assert.deepEqual(schema.properties.state.properties.readers, {
      type: 'array',
      items: { type: 'string' },
    });
  } finally {
    rmSync(root, { recursive: true });
  }
});
test('runtime refinements cannot introduce label or override a TS type', () => {
  const shape = workflowNodeSchemas().agent;
  assert.throws(
    () => constrainSchema(shape, { properties: { label: { minLength: 1 } } }),
    /Unknown workflow constraint field/,
  );
  assert.throws(
    () => constrainSchema(shape, { properties: { name: { type: 'number' } } }),
    /must be defined in workflow.d.ts/,
  );
  assert.equal(
    constrainSchema(shape, {
      properties: { maxToolCalls: { minimum: 1, maximum: 50, default: 8 } },
    }).properties.maxToolCalls.maximum,
    50,
  );
});

test('credential refinements apply only to the appropriate union variants', () => {
  const shape = workflowNodeSchemas().remote_agent;
  const schema = constrainSchema(shape, {
    properties: {
      authentication: {
        properties: {
          credentialId: { minLength: 1 },
          headerName: { minLength: 1 },
        },
      },
    },
  });
  const variants = schema.properties.authentication.anyOf;
  const none = variants.find(
    (variant) => variant.properties.type.const === 'none',
  );
  const bearer = variants.find(
    (variant) => variant.properties.type.const === 'bearer',
  );
  const apiKey = variants.find(
    (variant) => variant.properties.type.const === 'apiKey',
  );
  assert.equal(Object.hasOwn(none.properties, 'credentialId'), false);
  assert.equal(bearer.properties.credentialId.minLength, 1);
  assert.equal(apiKey.properties.headerName.minLength, 1);
});
