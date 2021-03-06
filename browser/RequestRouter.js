var URI = require('catberry-uri').URI;

const MOUSE_PRIMARY_KEY = 0;
const HREF_ATTRIBUTE_NAME = 'href';
const TARGET_ATTRIBUTE_NAME = 'target';
const A_TAG_NAME = 'A';
const BODY_TAG_NAME = 'BODY';

class RequestRouter {
  /**
   * Client-side router
   * @param {ServiceLocator} $serviceLocator
   */
  constructor ($serviceLocator) {
    this._eventBus = $serviceLocator.resolve('eventBus');
    this._window = $serviceLocator.resolve('window');
    this._urlArgsProvider = $serviceLocator.resolve('urlArgsProvider');
    this._contextFactory = $serviceLocator.resolve('contextFactory');
    this._documentRenderer = $serviceLocator.resolve('documentRenderer');

    this._isHistorySupported = this._window.history &&
      this._window.history.pushState instanceof Function;

    // add event handlers
    this._wrapDocument();

    this._changeState(new URI(this._window.location.toString()))
      .catch(reason => this._handleError(reason));
  }

  /**
   * Current initialization flag.
   * @type {boolean}
   * @private
   */
  _isStateInitialized = false;

  /**
   * Current referrer.
   * @type {String|URI}
   * @private
   */
  _referrer = '';

  /**
   * Current location.
   * @type {URI}
   * @private
   */
  _location = null;

  /**
   * Current event bus.
   * @type {EventEmitter}
   * @private
   */
  _eventBus = null;

  /**
   * Current context factory.
   * @type {ContextFactory}
   * @private
   */
  _contextFactory = null;

  /**
   * Current state provider.
   * @type {URLArgsProvider}
   * @private
   */
  _urlArgsProvider = null;

  /**
   * Current document renderer.
   * @type {DocumentRenderer}
   * @private
   */
  _documentRenderer = null;

  /**
   * Current browser window.
   * @type {Window}
   * @private
   */
  _window = null;

  /**
   * True if current browser supports history API.
   * @type {boolean}
   * @private
   */
  _isHistorySupported = false;

  /**
   * Routes browser render request.
   * @param {Object} [options={}]
   * @param {boolean} options.silent
   * @returns {Promise} Promise for nothing.
   */
  route (options = {}) {
    // because now location was not change yet and
    // different browsers handle `popstate` differently
    // we need to do route in next iteration of event loop
    return Promise.resolve()
      .then(() => {
        var newLocation = new URI(this._window.location.toString());
        var newAuthority = newLocation.authority ? newLocation.authority.toString() : null;
        var currentAuthority = this._location.authority ? this._location.authority.toString() : null;

        if (newLocation.scheme !== this._location.scheme || newAuthority !== currentAuthority) {
          this._isSilentHistoryChanging = false;
          return Promise.resolve();
        }

        // if only URI fragment is changed
        var newQuery = newLocation.query ? newLocation.query.toString() : null;
        var currentQuery = this._location.query ? this._location.query.toString() : null;

        if (newLocation.path === this._location.path && newQuery === currentQuery) {
          this._location = newLocation;
          this._isSilentHistoryChanging = false;
          return Promise.resolve();
        }

        return this._changeState(newLocation, options);
      });
  }

  /**
   * Sets application state to specified URI.
   * @param {string} locationString URI to go.
   * @param {Object} [options={}]
   * @param {boolean} options.silent routing without run signal related to URI
   * @returns {Promise} Promise for nothing.
   */
  go (locationString, options = {}) {
    return Promise.resolve()
      .then(() => {
        var location = new URI(locationString);
        location = location.resolveRelative(this._location);
        locationString = location.toString();

        var currentAuthority = this._location.authority ? this._location.authority.toString() : null;
        var newAuthority = location.authority ? location.authority.toString() : null;

        // we must check if this is an external link before map URI
        // to internal application state
        if (!this._isHistorySupported ||
          location.scheme !== this._location.scheme ||
          newAuthority !== currentAuthority) {
          this._window.location.assign(locationString);
          return Promise.resolve();
        }

        var { args, signal } = this._urlArgsProvider.getArgsAndSignalByUri(location);

        if (!args || !signal) {
          this._window.location.assign(locationString);
          return Promise.resolve();
        }

        this._window.history.pushState({}, '', locationString);
        return this.route(options);
      });
  }

  /**
   * Changes current application state with new location.
   * @param {URI} newLocation New location.
   * @param {Object} [options={}]
   * @param {boolean} options.silent
   * @returns {Promise} Promise for nothing.
   * @private
   */
  _changeState (newLocation, options = {}) {
    return Promise.resolve()
      .then(() => {
        this._location = newLocation;
        var { args, signal } = this._urlArgsProvider.getArgsAndSignalByUri(newLocation);

        var routingContext = this._contextFactory.create({
          referrer: this._referrer || this._window.document.referrer,
          location: this._location,
          userAgent: this._window.navigator.userAgent
        });

        if (!this._isStateInitialized) {
          this._isStateInitialized = true;
          return this._documentRenderer.initWithState({ args, signal }, routingContext);
        }

        if (!args || !signal) {
          window.location.reload();
          return Promise.resolve();
        }

        return this._documentRenderer.updateState({ args, signal }, routingContext, options);
      })
      .then(() => {
        this._referrer = this._location;
      });
  }

  /**
   * Wraps document with required events to route requests.
   * @private
   */
  _wrapDocument () {
    if (!this._isHistorySupported) {
      return;
    }

    this._window.addEventListener('popstate', () => {
      this.route()
        .catch(this._handleError.bind(this));
    });

    this._window.document.body.addEventListener('click', event => {
      if (event.defaultPrevented) {
        return;
      }

      if (event.target.tagName === A_TAG_NAME) {
        this._linkClickHandler(event, event.target);
      } else {
        var link = closestLink(event.target);
        if (!link) {
          return;
        }
        this._linkClickHandler(event, link);
      }
    });
  }

  /**
   * Handles link click on the page.
   * @param {Event} event Event-related object.
   * @param {Element} element Link element.
   * @private
   */
  _linkClickHandler (event, element) {
    var targetAttribute = element.getAttribute(TARGET_ATTRIBUTE_NAME);
    if (targetAttribute) {
      return;
    }

    // if middle mouse button was clicked
    if (event.button !== MOUSE_PRIMARY_KEY ||
      event.ctrlKey || event.altKey || event.shiftKey) {
      return;
    }

    var locationString = element.getAttribute(HREF_ATTRIBUTE_NAME);
    if (!locationString) {
      return;
    }
    if (locationString[0] === '#') {
      return;
    }

    event.preventDefault();
    this.go(locationString)
      .catch(this._handleError.bind(this));
  }

  /**
   * Handles all errors.
   * @param {Error} error Error to handle.
   * @private
   */
  _handleError (error) {
    this._eventBus.emit('error', error);
  }
}

/**
 * Finds the closest ascending "A" element node.
 * @param {Node} element DOM element.
 * @returns {Node|null} The closest "A" element or null.
 */
function closestLink (element) {
  while (element && element.nodeName !== A_TAG_NAME && element.nodeName !== BODY_TAG_NAME) {
    element = element.parentNode;
  }
  return element && element.nodeName === A_TAG_NAME ? element : null;
}

module.exports = RequestRouter;
