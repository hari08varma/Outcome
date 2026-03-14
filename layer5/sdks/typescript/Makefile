.PHONY: build publish test clean

build:
	cd sdks/typescript && npm run build

test-publish:
	cd sdks/typescript && \
	npm publish --dry-run
	# Shows what would be published without 
	# actually publishing. Verify output.

publish:
	cd sdks/typescript && \
	npm publish --access public
	# Requires: npm login (or NPM_TOKEN env var)

test:
	cd sdks/typescript && npm test

clean:
	rm -rf sdks/typescript/dist/
