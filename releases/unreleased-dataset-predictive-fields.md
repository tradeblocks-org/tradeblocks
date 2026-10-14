# Dataset predictive analysis

- find_predictive_fields, filter_curve and get_field_statistics resolve built-in market and registered dataset fields at trade entry using the shared timing contract.
- Predictive reports populate the Static Dataset field slot; registered numeric fields participate in ranking.
- filter_curve refuses unknown or uncovered dataset fields by name rather than producing a misleading empty result.
- get_field_statistics reports dataset distributions and per-field age using the same resolved observations as the other aggregate tools. Existing trade-field statistics retain their output shape.
