.PHONY: build publish test clean

build:
	cd sdks/python && \
	pip install build twine --quiet && \
	python -m build

test-publish:
	cd sdks/python && \
	twine upload --repository testpypi dist/*
	# Verify: pip install -i https://test.pypi.org/
	#         simple/ layer5-sdk

publish:
	cd sdks/python && \
	twine upload dist/*
	# Requires: TWINE_USERNAME=__token__
	#           TWINE_PASSWORD=[PyPI API token]

test:
	cd sdks/python && \
	python -m pytest tests/ -v

clean:
	rm -rf sdks/python/dist/ sdks/python/*.egg-info/
