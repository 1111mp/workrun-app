//! Test-only outcome grading. Expectations belong to evaluation assets, never to
//! runtime nodes or production Skills. No graph topology or model prose is graded.
use super::session::RunObservation;
use serde_json::Value;

#[derive(Debug, PartialEq)]
pub(super) enum Verdict {
    Passed,
    Incorrect,
    Unobserved,
    ExecutionFailed,
}

#[derive(Debug)]
pub(super) struct Check {
    pub pointer: String,
    pub expected: Value,
    pub observed: Option<Value>,
    pub verdict: Verdict,
}

#[derive(Debug)]
pub(super) struct Assessment {
    pub verdict: Verdict,
    pub checks: Vec<Check>,
}

/// JSON pointers address the native run state, including permitted outputs.
/// Missing output is unknown evidence; an explicit null is an observed value.
pub(super) fn assess(run: Option<&RunObservation>, expected: &[(&str, Value)]) -> Assessment {
    let checks: Vec<_> = expected
        .iter()
        .map(|(pointer, expected)| {
            let observed = run.and_then(|run| run.state.pointer(pointer)).cloned();
            let verdict = match &observed {
                None => Verdict::Unobserved,
                Some(value) if value == expected => Verdict::Passed,
                Some(_) => Verdict::Incorrect,
            };
            Check {
                pointer: (*pointer).into(),
                expected: expected.clone(),
                observed,
                verdict,
            }
        })
        .collect();
    let verdict = match run {
        Some(run) if run.error.is_some() || matches!(run.status.as_str(), "failed" | "cancelled") => {
            Verdict::ExecutionFailed
        },
        Some(run) if run.status == "completed" => {
            if checks.iter().any(|check| check.verdict == Verdict::Incorrect) {
                Verdict::Incorrect
            } else if checks.is_empty() || checks.iter().any(|check| check.verdict == Verdict::Unobserved) {
                Verdict::Unobserved
            } else {
                Verdict::Passed
            }
        },
        _ => Verdict::Unobserved,
    };
    Assessment { verdict, checks }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn completed(state: Value) -> RunObservation {
        RunObservation {
            status: "completed".into(),
            name: "fixture".into(),
            error: None,
            state,
        }
    }

    #[test]
    fn outcome_evaluation_rejects_completed_but_wrong_and_preserves_diagnostics() {
        let run = completed(json!({"global":{"total":7,"report":"All checks passed"}}));
        let result = assess(Some(&run), &[("/global/total", json!(11))]);
        assert_eq!(result.verdict, Verdict::Incorrect);
        let check = &result.checks[0];
        assert_eq!(check.pointer, "/global/total");
        assert_eq!(check.expected, 11);
        assert_eq!(check.observed, Some(json!(7)));
    }

    #[test]
    fn outcome_evaluation_missing_checks_runs_and_outputs_never_pass() {
        assert_eq!(
            assess(None, &[("/global/result", json!(null))]).verdict,
            Verdict::Unobserved
        );
        assert_eq!(assess(Some(&completed(json!({}))), &[]).verdict, Verdict::Unobserved);
        let expected = [("/global/result", json!(null))];
        assert_eq!(
            assess(Some(&completed(json!({"global":{}}))), &expected).verdict,
            Verdict::Unobserved
        );
        assert_eq!(
            assess(Some(&completed(json!({"global":{"result":null}}))), &expected).verdict,
            Verdict::Passed
        );
        let mut run = completed(json!({"global":{"result":null}}));
        run.status = "running".into();
        assert_eq!(assess(Some(&run), &expected).verdict, Verdict::Unobserved);
        run.status = "failed".into();
        assert_eq!(assess(Some(&run), &expected).verdict, Verdict::ExecutionFailed);
        run.status = "completed".into();
        run.error = Some("executor failed".into());
        assert_eq!(assess(Some(&run), &expected).verdict, Verdict::ExecutionFailed);
    }

    #[test]
    fn outcome_evaluation_compares_changed_inputs_with_independent_expectations() {
        // These synthetic observations test the grader, not autonomous authoring.
        // Integer arithmetic avoids silently choosing a financial rounding policy.
        for input in [vec![2_i64, 5, 4], vec![8, 14], vec![]] {
            let expected = [("/global/total", json!(input.iter().sum::<i64>()))];
            let stale = completed(json!({"global":{"total":11}}));
            assert_eq!(
                assess(Some(&stale), &expected).verdict,
                if input.iter().sum::<i64>() == 11 {
                    Verdict::Passed
                } else {
                    Verdict::Incorrect
                }
            );
        }
    }

    #[test]
    fn outcome_evaluation_handles_non_numeric_outputs_without_graph_requirements() {
        for (observed, expected) in [
            (json!(["a", "b"]), json!(["a", "b"])),
            (
                json!({"title":"Hello","unit":null}),
                json!({"title":"Hello","unit":null}),
            ),
            (json!(["a", "a", "b"]), json!(["a", "b"])),
            (
                json!({"title":"Hello","unit":"USD"}),
                json!({"title":"Hello","unit":null}),
            ),
        ] {
            let verdict = if observed == expected {
                Verdict::Passed
            } else {
                Verdict::Incorrect
            };
            let run = completed(json!({"global":{"result":observed}}));
            assert_eq!(assess(Some(&run), &[("/global/result", expected)]).verdict, verdict);
        }
    }
}
