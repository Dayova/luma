# Asynchronous Analysis Transaction Strategy

Accepted. Observation acceptance is transactional and independent from long model or provider calls. The implementation may claim analysis work, perform context and model work outside the write transaction, then reconcile against the expected Revision or defer analysis for retry.
