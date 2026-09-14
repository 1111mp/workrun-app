use crate::{
    cmd::{CmdResult, StringifyErr},
    module::evaluation::{
        ClaimedEvaluationCase, CreateEvaluationCase, CreateEvaluationRun, CreateEvaluationSuite,
        EvaluationCaseResultSummary, EvaluationCaseSummary, EvaluationRunDetail, EvaluationRunSummary, EvaluationStore,
        EvaluationSuiteSummary, UpdateEvaluationCase, UpdateEvaluationSuite,
    },
};

#[tauri::command]
pub async fn evaluation_suite_create(request: CreateEvaluationSuite) -> CmdResult<EvaluationSuiteSummary> {
    EvaluationStore::create_suite(request).await.stringify_err()
}

#[tauri::command]
pub async fn evaluation_suite_list(workflow_id: String) -> CmdResult<Vec<EvaluationSuiteSummary>> {
    EvaluationStore::list_suites(&workflow_id).await.stringify_err()
}

#[tauri::command]
pub async fn evaluation_suite_update(request: UpdateEvaluationSuite) -> CmdResult<EvaluationSuiteSummary> {
    EvaluationStore::update_suite(request).await.stringify_err()
}

#[tauri::command]
pub async fn evaluation_suite_delete(id: String) -> CmdResult {
    EvaluationStore::delete_suite(&id).await.stringify_err()
}

#[tauri::command]
pub async fn evaluation_case_create(request: CreateEvaluationCase) -> CmdResult<EvaluationCaseSummary> {
    EvaluationStore::create_case(request).await.stringify_err()
}

#[tauri::command]
pub async fn evaluation_case_list(suite_id: String) -> CmdResult<Vec<EvaluationCaseSummary>> {
    EvaluationStore::list_cases(&suite_id).await.stringify_err()
}

#[tauri::command]
pub async fn evaluation_case_update(request: UpdateEvaluationCase) -> CmdResult<EvaluationCaseSummary> {
    EvaluationStore::update_case(request).await.stringify_err()
}

#[tauri::command]
pub async fn evaluation_case_delete(id: String) -> CmdResult {
    EvaluationStore::delete_case(&id).await.stringify_err()
}

#[tauri::command]
pub async fn evaluation_case_reorder(suite_id: String, ids: Vec<String>) -> CmdResult {
    EvaluationStore::reorder_cases(&suite_id, &ids).await.stringify_err()
}

#[tauri::command]
pub async fn evaluation_run_create(request: CreateEvaluationRun) -> CmdResult<EvaluationRunSummary> {
    EvaluationStore::create_run(request).await.stringify_err()
}

#[tauri::command]
pub async fn evaluation_run_claim_next_case(evaluation_run_id: String) -> CmdResult<Option<ClaimedEvaluationCase>> {
    EvaluationStore::claim_next_case(&evaluation_run_id)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn evaluation_run_start_next_case(evaluation_run_id: String) -> CmdResult<Option<ClaimedEvaluationCase>> {
    EvaluationStore::start_next_case(&evaluation_run_id)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn evaluation_run_case_results(evaluation_run_id: String) -> CmdResult<Vec<EvaluationCaseResultSummary>> {
    EvaluationStore::list_case_results(&evaluation_run_id)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn evaluation_run_inspect(evaluation_run_id: String) -> CmdResult<EvaluationRunDetail> {
    EvaluationStore::inspect_run(&evaluation_run_id).await.stringify_err()
}

#[tauri::command]
pub async fn evaluation_run_list(suite_id: String) -> CmdResult<Vec<EvaluationRunDetail>> {
    EvaluationStore::list_runs(&suite_id).await.stringify_err()
}
