DROP TRIGGER identifier_equivalence_envelope_pair_insert;

CREATE TRIGGER identifier_equivalence_envelope_pair_insert
BEFORE INSERT ON identifier_equivalences
WHEN NEW.normalized_identifier_ciphertext IS NULL OR
     NEW.normalized_identifier_envelope_key_id IS NULL OR
     NEW.normalized_identifier_envelope_format IS NULL
BEGIN
  SELECT RAISE(ABORT,'new identifier equivalence requires complete envelope');
END;
