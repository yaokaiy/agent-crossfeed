.PHONY: test test-py test-ts validate

test: test-py test-ts validate

test-py:
	python3 -I -m unittest discover -s tests/py -v

test-ts:
	claude plugin test .

validate:
	claude plugin validate .
