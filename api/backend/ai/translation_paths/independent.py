"""Original 14.8 path. No history, conversation store or sequencing side effects."""

def execute(invoke, source, target_lang, ai, **kwargs):
    from backend.ai import wire_trace, trace_preview
    evidence = {"schema":"tp.conversation/1", "mode":"independent", "path":"independent",
        "phase":"prepared", "historyTurns":0, "historyMessages":0,
        "legacyFallback":False, "providerCallsAdded":0, "commitStatus":"not_applicable"}
    trace_preview.note("AI translation path", evidence)
    wire_trace.write_json("03_conversation_path.json", evidence)
    return invoke(source, target_lang, ai, **kwargs)
