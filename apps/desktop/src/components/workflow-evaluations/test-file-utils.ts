import type { EvaluationCase, EvaluationSuite } from '@/services/evaluation';

export function adkTestFile(suite: EvaluationSuite, cases: EvaluationCase[]) {
  return {
    eval_set_id: suite.id,
    name: suite.name,
    description: suite.description,
    eval_cases: cases.map((item) => {
      const expectation = item.expectation as Record<string, unknown>;
      const textAssertion = Array.isArray(expectation.assertions)
        ? (expectation.assertions.find(
            (rule) => (rule as Record<string, unknown>)?.kind === 'text',
          ) as Record<string, unknown> | undefined)
        : undefined;
      const trajectory = Array.isArray(expectation.assertions)
        ? (expectation.assertions.find(
            (rule) =>
              (rule as Record<string, unknown>)?.kind === 'tool_trajectory',
          ) as Record<string, unknown> | undefined)
        : undefined;
      return {
        eval_id: item.id,
        description: item.description,
        conversation: [
          {
            invocation_id: item.id,
            user_content: {
              role: 'user',
              parts: [{ text: JSON.stringify(item.input) }],
            },
            final_response: textAssertion?.expected
              ? { role: 'model', parts: [{ text: textAssertion.expected }] }
              : undefined,
            intermediate_data: trajectory
              ? { tool_uses: trajectory.tools ?? [] }
              : undefined,
          },
        ],
        session_input: { state: item.input },
        workrun: {
          name: item.name,
          enabled: item.enabled,
          expectation: item.expectation,
          fixture: item.fixture,
        },
      };
    }),
  };
}
