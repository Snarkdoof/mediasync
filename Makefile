.PHONY: all clean build

SRC = mediasync-v2.js
DIST_DIR = dist
DIST_FILE = $(DIST_DIR)/mediasync-v2.js
# MIN_FILE = $(DIST_DIR)/mediasync-v2.min.js

all: build

build: $(DIST_FILE)

$(DIST_DIR):
	mkdir -p $(DIST_DIR)

$(DIST_FILE): $(SRC) | $(DIST_DIR)
	cp $(SRC) $(DIST_FILE)
	@echo "Build successful: $(DIST_FILE) created."

# To enable minification, uncomment MIN_FILE above, add $(MIN_FILE) to the build target, 
# and uncomment the block below. (Requires 'npx terser' or similar tool)
# $(MIN_FILE): $(DIST_FILE)
# 	npx terser $(DIST_FILE) -o $(MIN_FILE) -c -m --comments '/^!|Copyright|License/'
# 	@echo "Minification successful: $(MIN_FILE) created."

clean:
	rm -rf $(DIST_DIR)
	@echo "Cleaned $(DIST_DIR) directory."