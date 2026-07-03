import { proxyHueOs } from '../../lib/hue-os-proxy.js';

export default {
  fetch(request) {
    return proxyHueOs(request, 'profile');
  },
};
