.PHONY: all clean build

SRC = mediasync-v2.js
DIST_DIR = dist
DIST_FILE = $(DIST_DIR)/mediasync-v2.js
MIN_FILE = $(DIST_DIR)/mediasync-v2.min.js

SRC_BASIC = basic-mediasync.js
DIST_BASIC = $(DIST_DIR)/basic-mediasync.js
MIN_BASIC = $(DIST_DIR)/basic-mediasync.min.js

SRC_SESSION = timing-media-session.js
DIST_SESSION = $(DIST_DIR)/timing-media-session.js
MIN_SESSION = $(DIST_DIR)/timing-media-session.min.js

all: build

build: $(DIST_FILE) $(MIN_FILE) $(DIST_BASIC) $(MIN_BASIC) $(DIST_SESSION) $(MIN_SESSION)

$(DIST_DIR):
	mkdir -p $(DIST_DIR)

$(DIST_FILE): $(SRC) | $(DIST_DIR)
	cp $(SRC) $(DIST_FILE)
	@echo "Build successful: $(DIST_FILE) created."

$(MIN_FILE): $(DIST_FILE)
	npx --yes --registry=https://registry.npmjs.org terser $(DIST_FILE) -o $(MIN_FILE) -c -m --comments '/^!|Copyright|License/'
	@echo "Minification successful: $(MIN_FILE) created."

$(DIST_BASIC): $(SRC_BASIC) | $(DIST_DIR)
	cp $(SRC_BASIC) $(DIST_BASIC)
	@echo "Build successful: $(DIST_BASIC) created."

$(MIN_BASIC): $(DIST_BASIC)
	npx --yes --registry=https://registry.npmjs.org terser $(DIST_BASIC) -o $(MIN_BASIC) -c -m --comments '/^!|Copyright|License/'
	@echo "Minification successful: $(MIN_BASIC) created."

$(DIST_SESSION): $(SRC_SESSION) | $(DIST_DIR)
	cp $(SRC_SESSION) $(DIST_SESSION)
	@echo "Build successful: $(DIST_SESSION) created."

$(MIN_SESSION): $(DIST_SESSION)
	npx --yes --registry=https://registry.npmjs.org terser $(DIST_SESSION) -o $(MIN_SESSION) -c -m --comments '/^!|Copyright|License/'
	@echo "Minification successful: $(MIN_SESSION) created."

clean:
	rm -rf $(DIST_DIR)
	@echo "Cleaned $(DIST_DIR) directory."
