import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse } from '@babel/parser';

const editorSource = new URL(
  '../src/components/workflow.d.ts',
  import.meta.url,
);
const srcRoot = new URL('../src/', import.meta.url);

/** Derive the JSON shape from the exact types consumed by the visual editor. */
export function workflowNodeSchemas(source = editorSource) {
  const files = new Map();
  function declarations(url) {
    if (!files.has(url.href)) {
      const ast = parse(readFileSync(url, 'utf8'), {
        sourceType: 'module',
        plugins: ['typescript'],
      });
      const aliases = new Map();
      for (const statement of ast.program.body) {
        const declaration =
          statement.type === 'ExportNamedDeclaration'
            ? statement.declaration
            : statement;
        if (declaration?.type === 'TSTypeAliasDeclaration')
          aliases.set(declaration.id.name, declaration.typeAnnotation);
      }
      files.set(url.href, aliases);
    }
    return files.get(url.href);
  }
  function resolve(name, file) {
    const declaration = declarations(file).get(name);
    if (!declaration)
      throw new Error(
        `Unknown workflow type ${name} in ${fileURLToPath(file)}`,
      );
    return schema(declaration, file);
  }
  function schema(node, file) {
    switch (node.type) {
      case 'TSStringKeyword':
        return { type: 'string' };
      case 'TSNumberKeyword':
        return { type: 'number' };
      case 'TSBooleanKeyword':
        return { type: 'boolean' };
      case 'TSNullKeyword':
        return { type: 'null' };
      case 'TSUnknownKeyword':
        return {};
      case 'TSParenthesizedType':
        return schema(node.typeAnnotation, file);
      case 'TSLiteralType':
        return { type: typeof node.literal.value, const: node.literal.value };
      case 'TSArrayType':
        return { type: 'array', items: schema(node.elementType, file) };
      case 'TSUnionType': {
        const variants = node.types.map((type) => schema(type, file));
        if (
          variants.every((variant) => 'const' in variant) &&
          variants.every((variant) => variant.type === variants[0].type)
        )
          return {
            type: variants[0].type,
            enum: variants.map((variant) => variant.const),
          };
        return { anyOf: variants };
      }
      case 'TSIntersectionType': {
        const parts = node.types.map((type) => schema(type, file));
        if (parts.some((part) => part.type !== 'object'))
          throw new Error(
            'Only object intersections are supported in workflow data',
          );
        return {
          type: 'object',
          properties: Object.assign(
            {},
            ...parts.map((part) => part.properties),
          ),
          required: [...new Set(parts.flatMap((part) => part.required))],
          additionalProperties: false,
        };
      }
      case 'TSTypeLiteral': {
        const properties = {},
          required = [];
        for (const field of node.members) {
          if (field.type !== 'TSPropertySignature' || field.computed)
            throw new Error(`Unsupported workflow member ${field.type}`);
          const name = field.key.name ?? field.key.value;
          properties[name] = schema(field.typeAnnotation.typeAnnotation, file);
          const comment = field.leadingComments?.find(
            (comment) =>
              comment.type === 'CommentBlock' && comment.value.startsWith('*'),
          );
          if (comment)
            properties[name].description = comment.value
              .replace(/^\*|\*$/g, '')
              .replace(/\n\s*\* ?/g, ' ')
              .trim();
          if (!field.optional) required.push(name);
        }
        return {
          type: 'object',
          properties,
          required,
          additionalProperties: false,
        };
      }
      case 'TSTypeReference': {
        const args = (node.typeParameters ?? node.typeArguments)?.params ?? [];
        if (node.typeName.name === 'Record') {
          if (args[0]?.type !== 'TSStringKeyword')
            throw new Error('Workflow records must use string keys');
          return {
            type: 'object',
            additionalProperties: schema(args[1], file),
          };
        }
        return resolve(node.typeName.name, file);
      }
      case 'TSImportType': {
        const path = node.argument.value;
        if (!path.startsWith('@/') || node.qualifier.type !== 'Identifier')
          throw new Error(`Unsupported workflow import ${path}`);
        return resolve(
          node.qualifier.name,
          new URL(`${path.slice(2)}.ts`, srcRoot),
        );
      }
      default:
        throw new Error(`Unsupported workflow type syntax ${node.type}`);
    }
  }
  const nodes = resolve('WorkflowNode', source).anyOf;
  if (declarations(source).has('WorkflowNodeType')) {
    const directory = resolve('WorkflowNodeType', source).enum;
    if (
      directory.slice().sort().join() !==
      nodes
        .map((node) => node.properties.type.const)
        .sort()
        .join()
    )
      throw new Error('WorkflowNodeType differs from WorkflowNode variants');
  }
  return Object.fromEntries(
    nodes.map((node) => [node.properties.type.const, node.properties.data]),
  );
}

/** Constraints can refine a TS field, never introduce another field or shape. */
export function constrainSchema(shape, constraints = {}, path = '') {
  const result = structuredClone(shape);
  for (const [key, value] of Object.entries(constraints)) {
    if (key === 'properties') {
      for (const [name, child] of Object.entries(value)) {
        // A discriminated union may have a field in only some variants (for
        // example credentialId on bearer/apiKey, but never on type=none).
        const targets = result.anyOf ?? [result];
        const matching = targets.filter(
          (target) =>
            target.properties && Object.hasOwn(target.properties, name),
        );
        if (!matching.length)
          throw new Error(`Unknown workflow constraint field ${path}.${name}`);
        for (const target of matching)
          target.properties[name] = constrainSchema(
            target.properties[name],
            child,
            `${path}.${name}`,
          );
      }
    } else if (key === 'items' || key === 'additionalProperties') {
      if (!result[key] || typeof result[key] !== 'object')
        throw new Error(`Invalid workflow constraint ${path}.${key}`);
      result[key] = constrainSchema(result[key], value, `${path}.${key}`);
    } else if (
      key === 'integer' &&
      value === true &&
      result.type === 'number'
    ) {
      result.type = 'integer';
    } else if (
      [
        'description',
        'minimum',
        'maximum',
        'minLength',
        'maxLength',
        'minItems',
        'maxItems',
        'uniqueItems',
        'pattern',
        'default',
      ].includes(key)
    ) {
      result[key] = value;
    } else
      throw new Error(
        `Constraint ${path}.${key} must be defined in workflow.d.ts`,
      );
  }
  return result;
}
