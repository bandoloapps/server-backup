import { INTEGER, STRING, Sequelize } from "sequelize";

export const define_initial_backup_progress = (sequelize: Sequelize) => {
    const model = sequelize.define('initial_backup_progress', {
        id: {
            type: INTEGER,
            primaryKey: true,
            defaultValue: 1
        },
        processedTotal: {
            type: INTEGER,
            defaultValue: 0
        },
        channelsDone: {
            type: INTEGER,
            defaultValue: 0
        },
        channelsTotal: {
            type: INTEGER,
            defaultValue: 0
        },
        startedAt: {
            type: INTEGER
        },
        lastUpdated: {
            type: INTEGER
        },
        status: {
            type: STRING,
            defaultValue: 'running'
        }
    }, {timestamps: false, freezeTableName: true})

    return model;
}
