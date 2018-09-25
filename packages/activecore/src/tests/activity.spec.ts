var should    = require('chai').should();
var supertest = require('supertest');
var api       = supertest('http://localhost:3000/api');

describe('Activity unit tests:', () => {
    it('Should create a Activity instance', (done: Function) => {
        api.post('/Activity').send({}).expect(200, done);
    });
});
