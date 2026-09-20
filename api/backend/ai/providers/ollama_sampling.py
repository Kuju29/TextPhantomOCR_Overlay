"""Native Ollama translation defaults (not model-discovery/probe settings).

These controls reduce sampling variation, not guarantee model quality or
bit-identical responses across runtime/model revisions. Other providers own
separate compatibility policies; do not copy these options to cloud payloads.
"""
OLLAMA_TRANSLATION_SAMPLING = {"temperature": 0.2, "seed": 0}
